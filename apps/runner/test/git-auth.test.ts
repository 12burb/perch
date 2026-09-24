import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommit, gitPush } from "../src/git.ts";
import {
  assertPushRemote,
  gitAuth,
  recordedOrigin,
  remoteOrigin,
  riskyTransportConfig,
} from "../src/git-auth.ts";
import { runnerPolicy } from "../src/policy.ts";
import { projectDir, setupProject } from "../src/projects.ts";
import { type GitHost, startGitHost } from "./helpers/git-http.ts";
import { removeTree } from "./helpers/tmp.ts";

/**
 * Git holding a credential (ADR-0171): no hook runs, no helper but Perch's is asked and Perch's
 * answers for the remote's own host only, and a push goes only where the project came from. The
 * pieces are unit-tested; the whole push runs against a git host on this machine that asks for the
 * token the way a real one does.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000c1";
const TOKEN = "ghs_the-connection-token";
const ctx = { workspace_id: WS, user_id: USER, cap: "test", project: PROJECT } as const;
const author = { name: "Perch Tests", email: "tests@perch.test" };
const posix = process.platform !== "win32";

describe("where a git URL goes", () => {
  test("https, http, ssh and scp's form have an origin; a path, file:// and ext:: have none", () => {
    expect(remoteOrigin("https://GitHub.com/o/r.git")).toEqual({
      scheme: "https",
      host: "github.com",
    });
    expect(remoteOrigin("https://github.com:443/o/r")).toEqual({
      scheme: "https",
      host: "github.com",
    });
    expect(remoteOrigin("http://127.0.0.1:4567/repo.git")).toEqual({
      scheme: "http",
      host: "127.0.0.1:4567",
    });
    expect(remoteOrigin("ssh://git@git.example.com:2222/o/r.git")).toEqual({
      scheme: "ssh",
      host: "git.example.com:2222",
    });
    expect(remoteOrigin("git@github.com:o/r.git")).toEqual({ scheme: "ssh", host: "github.com" });
    for (const nowhere of [
      "/srv/git/repo.git",
      "file:///srv/git/repo.git",
      "ext::sh -c cat% /etc/passwd",
      "C:\\repos\\r.git",
      "fd::3",
    ]) {
      expect(remoteOrigin(nowhere)).toBeNull();
    }
  });
});

describe("what a credentialed git run is told (the https case)", () => {
  const origin = { scheme: "https" as const, host: "github.com" };

  test("no hooks, no helper but Perch's, and Perch's for this host only; the token is not on argv", () => {
    const auth = gitAuth({ kind: "token", token: TOKEN }, undefined, origin);
    expect(auth.config).toContain("core.hooksPath=/dev/null");
    expect(auth.config).toContain("http.sslVerify=true");
    expect(auth.config).toContain("protocol.allow=never");
    expect(auth.config).toContain("protocol.https.allow=always");
    expect(auth.config).toContain("protocol.ext.allow=never");
    // The reset comes before Perch's helper: git reads -c after every file, in order.
    const reset = auth.config.indexOf("credential.helper=");
    const ours = auth.config.findIndex((entry) =>
      entry.startsWith("credential.https://github.com.helper=!"),
    );
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(ours).toBeGreaterThan(reset);
    expect(auth.config.filter((entry) => /^credential\.helper=./.test(entry))).toEqual([]);
    expect(auth.config.join("\n")).not.toContain(TOKEN);
    expect(auth.env.PERCH_GIT_SECRET).toBe(TOKEN);
    expect(() => gitAuth({ kind: "token", token: TOKEN })).toThrow(/remote it is for/);
  });

  test("a push goes over the credential's own transport, to the host the project came from", () => {
    const token = { kind: "token" as const, token: TOKEN };
    const key = { kind: "ssh" as const, privateKey: "KEY" };
    expect(assertPushRemote(token, "https://github.com/o/r.git", origin)).toEqual(origin);
    // Somewhere else, or somewhere a rewrite leads, is refused.
    expect(() => assertPushRemote(token, "https://evil.example/o/r.git", origin)).toThrow(
      /evil\.example/,
    );
    // A token never travels in the clear, except to this machine.
    expect(() => assertPushRemote(token, "http://github.com/o/r.git", null)).toThrow(/https/);
    expect(assertPushRemote(token, "http://127.0.0.1:9/r.git", null).host).toBe("127.0.0.1:9");
    // A local path or file:// has no host to send a credential to.
    expect(() => assertPushRemote(token, "/srv/git/r.git", null)).toThrow(/neither/);
    expect(() => assertPushRemote(token, "file:///srv/git/r.git", null)).toThrow(/neither/);
    // A deploy key goes over ssh, to the same host a clone over https came from.
    expect(assertPushRemote(key, "git@github.com:o/r.git", origin).scheme).toBe("ssh");
    expect(() => assertPushRemote(key, "https://github.com/o/r.git", origin)).toThrow(/ssh/);
  });

  test("a repository's own proxy, CA or TLS setting is refused; a global or system one is not a member's", () => {
    const listing = [
      "system\tsafe.directory=*",
      "global\thttp.proxy=http://corp-proxy:3128",
      "local\thttp.postbuffer=524288000",
      "local\thttp.proxy=http://127.0.0.1:1",
      "local\thttp.https://github.com/.sslcainfo=/tmp/evil.pem",
      "worktree\thttp.sslverify=false",
      "local\tremote.origin.proxy=http://evil",
      "command\thttp.sslverify=true",
    ].join("\n");
    expect(riskyTransportConfig(listing)).toEqual([
      "local http.proxy",
      "local http.https://github.com/.sslcainfo",
      "worktree http.sslverify",
      "local remote.origin.proxy",
    ]);
  });
});

describe.skipIf(!posix)(
  "a credentialed push, end to end, against a git host on this machine",
  () => {
    let host: GitHost;
    let root = "";
    let dir = "";
    let trap = "";
    const opts = () => ({ root, policy: runnerPolicy() });

    beforeAll(async () => {
      host = startGitHost(TOKEN);
      root = mkdtempSync(join(tmpdir(), "perch-git-auth-"));
      trap = mkdtempSync(join(tmpdir(), "perch-git-trap-"));
      await setupProject(
        { root },
        {
          ...ctx,
          source: { kind: "clone", url: host.url, auth: { kind: "token", token: TOKEN } },
        },
      );
      dir = projectDir(root, WS, PROJECT);
    }, 60_000);

    afterAll(() => {
      host?.stop();
      removeTree(root);
      removeTree(trap);
    });

    test("the clone asked for the token and recorded where the project came from", () => {
      expect(existsSync(join(dir, "README.md"))).toBe(true);
      expect(host.seen.some((auth) => auth.startsWith("Basic "))).toBe(true);
      expect(recordedOrigin(root, WS, PROJECT)).toEqual(remoteOrigin(host.url));
    });

    test("a hook the tree points at does not run, and a helper the repository configured never sees the token", async () => {
      // What any member can do to a shared checkout: point core.hooksPath into the tree, and add a
      // credential helper of their own — git calls every helper's `store` after a successful push.
      const hooks = join(dir, ".githooks");
      mkdirSync(hooks, { recursive: true });
      const marker = join(trap, "hook-ran");
      const captured = join(trap, "helper-saw");
      writeFileSync(
        join(hooks, "pre-push"),
        `#!/bin/sh\nenv > ${JSON.stringify(marker)}\nexit 0\n`,
      );
      chmodSync(join(hooks, "pre-push"), 0o755);
      Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"], { cwd: dir });
      Bun.spawnSync(
        [
          "git",
          "config",
          "--add",
          "credential.helper",
          `!f() { cat >> ${JSON.stringify(captured)}; }; f`,
        ],
        { cwd: dir },
      );
      writeFileSync(join(dir, "change.txt"), "a change\n");
      await gitCommit(opts(), { ...ctx, message: "a change", author });
      const before = host.seen.length;
      const pushed = await gitPush(opts(), { ...ctx, auth: { kind: "token", token: TOKEN } });
      expect(pushed).toMatchObject({ pushed: true, branch: "main" });
      // It arrived, with the token, at the host it was for.
      const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
      expect(host.seen.slice(before)).toContain(expected);
      const landed = Bun.spawnSync([
        "git",
        "--git-dir",
        host.bare,
        "log",
        "-1",
        "--format=%s",
        "main",
      ]);
      expect(landed.stdout.toString().trim()).toBe("a change");
      // And nothing of the member's ran with it.
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(captured) ? readFileSync(captured, "utf8") : "").not.toContain(TOKEN);
    }, 60_000);

    test("a push whose effective URL leads to another host is refused before git pushes", async () => {
      // Another host on this machine, listening and writing down every credential it is offered.
      const elsewhere = startGitHost("not-this-token");
      const rewrite = `url.${new URL(elsewhere.url).origin}/.insteadOf`;
      try {
        // An insteadOf rewrite: `origin` still reads the same, and the push would go elsewhere.
        Bun.spawnSync(["git", "config", rewrite, `${new URL(host.url).origin}/`], { cwd: dir });
        writeFileSync(join(dir, "again.txt"), "again\n");
        await gitCommit(opts(), { ...ctx, message: "again", author });
        const before = host.seen.length;
        await expect(
          gitPush(opts(), { ...ctx, auth: { kind: "token", token: TOKEN } }),
        ).rejects.toThrow(new RegExp(new URL(elsewhere.url).host.replace(/\./g, "\\.")));
        // Refused before git ran: neither host heard anything, least of all the token.
        expect(elsewhere.seen).toEqual([]);
        expect(host.seen.length).toBe(before);
      } finally {
        Bun.spawnSync(["git", "config", "--unset", rewrite], { cwd: dir });
        elsewhere.stop();
      }
    }, 60_000);

    test("a repository whose own config sets a proxy for the push is refused before git pushes", async () => {
      Bun.spawnSync(["git", "config", "http.proxy", "http://127.0.0.1:9"], { cwd: dir });
      const before = host.seen.length;
      await expect(
        gitPush(opts(), { ...ctx, auth: { kind: "token", token: TOKEN } }),
      ).rejects.toThrow(/http\.proxy/);
      expect(host.seen.length).toBe(before);
      Bun.spawnSync(["git", "config", "--unset", "http.proxy"], { cwd: dir });
      // Put right, it pushes.
      expect(
        await gitPush(opts(), { ...ctx, auth: { kind: "token", token: TOKEN } }),
      ).toMatchObject({ pushed: true });
    }, 60_000);
  },
);
