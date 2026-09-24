import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, type RunnerServices } from "../src/handlers.ts";
import {
  asUser,
  asUserFs,
  CREDENTIALED_GIT,
  FIRST_MEMBER_UID,
  GIT_UID,
  Isolation,
  isolationWanted,
  PERCH_GID,
  SHARED_UID,
  UID_MAP_FILE,
  useIsolation,
} from "../src/identity.ts";
import { runnerPolicy } from "../src/policy.ts";
import { PtyManager, tmux, tmuxSessionName } from "../src/pty.ts";
import { createStreamPair } from "../src/streams.ts";
import { startGitHost } from "./helpers/git-http.ts";
import { removeTree } from "./helpers/tmp.ts";

/**
 * ADR-0171, as the kernel sees it: members of one workspace on one hosted runner run as uids of
 * their own. These tests switch uids for real, so they run where the test process is root on Linux
 * (a container, CI as root) and are skipped, saying so, everywhere else. The rest of the runner's
 * tests run with isolation off, which is how every non-hosted runner runs.
 */

const rootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
const WS = "0190f2d0-0000-7000-8000-000000000001";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000a1";
const ALICE = "0190f2d0-0000-7000-8000-00000000a11c";
const BOB = "0190f2d0-0000-7000-8000-000000000b0b";
const WRAPPER = join(import.meta.dir, "..", "..", "..", "deploy", "perch-as");
const PATH = process.env.PATH ?? "/usr/bin:/bin";

type Run = { exitCode: number; stdout: string; stderr: string };

function run(argv: string[], env: Record<string, string>, cwd?: string): Run {
  const proc = Bun.spawnSync(argv, {
    env,
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** A command as `who`, through the runner's one helper. */
function as(who: string | null, argv: string[], cwd?: string): Run {
  const launch = asUser(who, argv, { PATH });
  return run(launch.argv, launch.env, cwd);
}

describe.skipIf(!rootOnLinux)(
  "members on a hosted runner, as the kernel sees them (root on Linux only)",
  () => {
    let dir = "";
    let homes = "";
    let projects = "";
    let passwd = "";
    let iso: Isolation;
    let services: RunnerServices;
    let umask = 0;

    function options() {
      return {
        homesRoot: homes,
        passwd,
        wrapper: WRAPPER,
        sharedHome: join(dir, "shared-home"),
        gitHome: join(dir, "git-home"),
      };
    }

    beforeAll(() => {
      umask = process.umask();
      dir = mkdtempSync(join(tmpdir(), "perch-identity-"));
      // Every uid in the test has to be able to walk down to the homes and the projects.
      chmodSync(dir, 0o755);
      homes = join(dir, "homes");
      projects = join(dir, "projects");
      passwd = join(dir, "passwd");
      copyFileSync("/etc/passwd", passwd);
      mkdirSync(join(dir, "shared-home"));
      chownSync(join(dir, "shared-home"), SHARED_UID, PERCH_GID);
      iso = new Isolation(options());
      iso.start(projects);
      useIsolation(iso);
      // Shells without tmux here: which tmux server a shell lands on is pty.test.ts's to prove.
      services = createServices({
        projects: { root: projects },
        policy: runnerPolicy(),
        pty: { tmux: false },
      });
    });

    afterAll(() => {
      services?.close();
      useIsolation(null);
      process.umask(umask);
      removeTree(dir);
    });

    test("it is on only where it can be: Linux, root, and asked for", () => {
      expect(isolationWanted({ PERCH_RUNNER_ISOLATION: "users" }, "linux", 0)).toBe(true);
      expect(isolationWanted({}, "linux", 0)).toBe(false);
      expect(isolationWanted({ PERCH_RUNNER_ISOLATION: "users" }, "linux", 1000)).toBe(false);
      expect(isolationWanted({ PERCH_RUNNER_ISOLATION: "users" }, "darwin", 0)).toBe(false);
    });

    test("two members get two uids, and the same two after the runner restarts", () => {
      const alice = iso.uidOf(ALICE);
      const bob = iso.uidOf(BOB);
      expect(alice).toBeGreaterThanOrEqual(FIRST_MEMBER_UID);
      expect(bob).not.toBe(alice);
      const again = new Isolation(options());
      expect(again.uidOf(BOB)).toBe(bob);
      expect(again.uidOf(ALICE)).toBe(alice);
      // The map is root's, and nobody else's to read or change.
      const map = statSync(join(homes, UID_MAP_FILE));
      expect(map.uid).toBe(0);
      expect(map.mode & 0o777).toBe(0o600);
      // Each has a passwd entry, once, and a home of their own.
      iso.member(ALICE);
      iso.member(ALICE);
      const entries = readFileSync(passwd, "utf8")
        .split("\n")
        .filter((line) => line.startsWith(`perch-u${alice}:`));
      expect(entries).toEqual([
        `perch-u${alice}:x:${alice}:${PERCH_GID}::${join(homes, ALICE)}:/bin/bash`,
      ]);
      const home = statSync(join(homes, ALICE));
      expect(home.uid).toBe(alice);
      expect(home.mode & 0o777).toBe(0o700);
      // A uid map that does not parse stops the runner rather than handing uids out again.
      const broken = mkdtempSync(join(tmpdir(), "perch-identity-broken-"));
      try {
        writeFileSync(join(broken, UID_MAP_FILE), '{"version":1,"users":{"x":1}}');
        expect(() => new Isolation({ ...options(), homesRoot: broken })).toThrow(/uid map/);
      } finally {
        removeTree(broken);
      }
    });

    test("a child runs as its member, with no capabilities, no groups but the shared one, and no way back", () => {
      const alice = iso.uidOf(ALICE);
      const status = as(ALICE, ["cat", "/proc/self/status"]).stdout;
      const field = (name: string) =>
        status
          .split("\n")
          .find((line) => line.startsWith(`${name}:`))
          ?.split(/\s+/)
          .slice(1)
          .filter(Boolean);
      expect(field("Uid")).toEqual([alice, alice, alice, alice].map(String));
      expect(field("Gid")).toEqual(["1000", "1000", "1000", "1000"]);
      expect(field("Groups")).toEqual([]);
      expect(field("CapEff")).toEqual(["0000000000000000"]);
      expect(field("CapBnd")).toEqual(["0000000000000000"]);
      expect(field("NoNewPrivs")).toEqual(["1"]);
      // Its HOME is its own, and so is the name it answers to.
      expect(as(ALICE, ["sh", "-c", 'echo "$HOME $USER"']).stdout.trim()).toBe(
        `${join(homes, ALICE)} perch-u${alice}`,
      );
      // A child that is nobody's is uid 1000; credentialed git is an account of its own.
      expect(as(null, ["id", "-u"]).stdout.trim()).toBe(String(SHARED_UID));
      expect(as(CREDENTIALED_GIT, ["id", "-u"]).stdout.trim()).toBe(String(GIT_UID));
    });

    test("a member's child cannot read another member's home", () => {
      const written = as(BOB, ["sh", "-c", 'echo "bob-login" > "$HOME/.credentials"']);
      expect(written.exitCode).toBe(0);
      const secret = join(homes, BOB, ".credentials");
      expect(readFileSync(secret, "utf8").trim()).toBe("bob-login");
      const read = as(ALICE, ["cat", secret]);
      expect(read.exitCode).not.toBe(0);
      expect(read.stderr).toContain("Permission denied");
      expect(read.stdout).not.toContain("bob-login");
      // Listing it is refused too, so nothing in it can even be named.
      expect(as(ALICE, ["ls", join(homes, BOB)]).exitCode).not.toBe(0);
    });

    test("a member's child cannot read the environment of the root process that started it", async () => {
      // The runner agent is root and holds its connect token in its environment; so does this one.
      const parent = Bun.spawn(["sleep", "30"], {
        env: { PATH, PERCH_RUNNER_TOKEN: "prt_the-runners-own" },
        stdout: "ignore",
      });
      try {
        await Bun.sleep(100);
        expect(readFileSync(`/proc/${parent.pid}/environ`, "utf8")).toContain(
          "prt_the-runners-own",
        );
        for (const pid of [parent.pid, process.pid, 1]) {
          const read = as(ALICE, ["cat", `/proc/${pid}/environ`]);
          expect(read.exitCode).not.toBe(0);
          expect(read.stdout).not.toContain("prt_");
          expect(read.stderr).toContain("Permission denied");
        }
      } finally {
        parent.kill();
      }
    });

    test("through the runner's own handlers: exec, a shell, and fs.read for one member never reach another's home", async () => {
      const ctx = { workspace_id: WS, cap: "test" } as const;
      await services.handlers["project.setup"]?.({
        ...ctx,
        user_id: ALICE,
        project: PROJECT,
        source: { kind: "empty" },
      });
      const secret = join(homes, BOB, ".credentials");
      const exec = await services.handlers.exec?.({
        ...ctx,
        user_id: ALICE,
        project: PROJECT,
        command: `id -u; cat ${secret}`,
        timeout: 10_000,
      });
      const result = exec as { exitCode: number; stdout: string; stderr: string };
      expect(result.stdout.trim().split("\n")[0]).toBe(String(iso.uidOf(ALICE)));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Permission denied");

      // What the runner reads for a member it reads as that member: even a link it would follow.
      expect(() => asUserFs(ALICE, () => readFileSync(secret, "utf8"))).toThrow(
        /EACCES|permission/i,
      );
      expect(() => asUserFs(ALICE, () => readFileSync(`/proc/${process.pid}/environ`))).toThrow(
        /EACCES|permission/i,
      );
      expect(asUserFs(BOB, () => readFileSync(secret, "utf8")).trim()).toBe("bob-login");
      const checkout = join(projects, WS, PROJECT);
      symlinkSync(secret, join(checkout, "peek"));
      await expect(
        services.handlers["fs.read"]?.({
          ...ctx,
          user_id: ALICE,
          project: PROJECT,
          path: "peek",
        }) ?? Promise.resolve(),
      ).rejects.toThrow();

      // A shell is its member's, HOME and all.
      const opened = await services.ptys.open({
        ...ctx,
        user_id: ALICE,
        cols: 80,
        rows: 24,
        cwd: `${WS}/${PROJECT}`,
        user: ALICE,
      });
      const pair = createStreamPair();
      let output = "";
      pair.a.onMessage((data) => {
        output += data;
      });
      services.ptys.attachToken(opened.stream_token, pair.b);
      const deadline = Date.now() + 20_000;
      let sent = false;
      while (!output.includes("] done") && Date.now() < deadline) {
        if (!sent && output.length > 0) {
          pair.a.send('echo "uid=[$(id -u)] home=[$HOME]" d""one\r');
          sent = true;
        }
        await Bun.sleep(100);
      }
      services.ptys.close(opened.pty_id);
      expect(output).toContain(`uid=[${iso.uidOf(ALICE)}] home=[${join(homes, ALICE)}] done`);
    }, 60_000);

    test("what one member writes in a project another can change: group 1000, setgid, group-writable", async () => {
      const ctx = { workspace_id: WS, cap: "test" } as const;
      const checkout = join(projects, WS, PROJECT);
      if (!existsSync(checkout)) {
        await services.handlers["project.setup"]?.({
          ...ctx,
          user_id: ALICE,
          project: PROJECT,
          source: { kind: "empty" },
        });
      }
      const workspace = statSync(join(projects, WS));
      expect(workspace.uid).toBe(0);
      expect(workspace.gid).toBe(PERCH_GID);
      expect(workspace.mode & 0o7777).toBe(0o3775);
      const project = statSync(checkout);
      expect(project.gid).toBe(PERCH_GID);
      expect(project.mode & 0o2070).toBe(0o2070);
      // Written by the runner for Alice: hers, the shared group's, group-writable.
      await services.handlers["fs.write"]?.({
        ...ctx,
        user_id: ALICE,
        project: PROJECT,
        path: "src/app.ts",
        content: "export const a = 1;\n",
      });
      const file = statSync(join(checkout, "src", "app.ts"));
      expect(file.uid).toBe(iso.uidOf(ALICE));
      expect(file.gid).toBe(PERCH_GID);
      expect(file.mode & 0o060).toBe(0o060);
      expect(statSync(join(checkout, "src")).mode & 0o2000).toBe(0o2000);
      // Written by Alice's own shell: the same.
      expect(as(ALICE, ["sh", "-c", "echo alice > notes.txt"], checkout).exitCode).toBe(0);
      // And Bob changes both.
      expect(
        as(BOB, ["sh", "-c", "echo bob >> notes.txt && echo bob >> src/app.ts"], checkout).exitCode,
      ).toBe(0);
      expect(readFileSync(join(checkout, "notes.txt"), "utf8")).toBe("alice\nbob\n");
      // git, through the wrapper, as each of them: a repository both can commit to.
      const git = statSync(join(checkout, ".git"));
      expect(git.uid).toBe(iso.uidOf(ALICE));
      const commit = await services.handlers["git.commit"]?.({
        ...ctx,
        user_id: BOB,
        project: PROJECT,
        message: "bob commits alice's work",
        author: { name: "Bob", email: "bob@perch.test" },
      });
      expect((commit as { commit: string }).commit).toMatch(/^[0-9a-f]+$/);
      const again = await services.handlers["fs.write"]?.({
        ...ctx,
        user_id: ALICE,
        project: PROJECT,
        path: "src/app.ts",
        content: "export const a = 2;\n",
      });
      expect(again).toEqual({ bytes: 20 });
      const second = await services.handlers["git.commit"]?.({
        ...ctx,
        user_id: ALICE,
        project: PROJECT,
        message: "alice commits on top",
        author: { name: "Alice", email: "alice@perch.test" },
      });
      expect((second as { commit: string }).commit).toMatch(/^[0-9a-f]+$/);
    }, 60_000);

    test.skipIf(!tmux())(
      "with tmux, each member's shell is on a server of their own, with their uid and HOME",
      async () => {
        const manager = new PtyManager({ root: projects, homes, graceMs: 60_000 });
        const checkout = join(projects, WS, PROJECT);
        const members = [ALICE, BOB];
        try {
          for (const member of members) {
            const opened = await manager.open({
              workspace_id: WS,
              user_id: member,
              cap: "test",
              cols: 80,
              rows: 24,
              cwd: checkout,
              user: member,
            });
            const pair = createStreamPair();
            let output = "";
            pair.a.onMessage((data) => {
              output += data;
            });
            manager.attachToken(opened.stream_token, pair.b);
            const deadline = Date.now() + 20_000;
            while (!output.includes("\u001b[?1049h") && Date.now() < deadline) await Bun.sleep(50);
            pair.a.send('echo "uid=[$(id -u)] home=[$HOME]" d""one\r');
            while (!output.includes("] done") && Date.now() < deadline) await Bun.sleep(50);
            manager.close(opened.pty_id);
            expect(output).toContain(
              `uid=[${iso.uidOf(member)}] home=[${join(homes, member)}] done`,
            );
            // The server is the member's: listed by them, under the name of their directory.
            const listed = as(member, ["tmux", "-L", tmuxSessionName(member, checkout), "ls"]);
            expect(listed.exitCode).toBe(0);
          }
        } finally {
          manager.closeAll();
          for (const member of members) {
            as(member, ["tmux", "-L", tmuxSessionName(member, checkout), "kill-server"]);
          }
        }
      },
      60_000,
    );

    test("credentialed git runs as its own account, and the member works on what it cloned", async () => {
      const host = startGitHost("ghs_isolated-token");
      const project = "0190f2d0-0000-7000-8000-0000000000c2";
      const ctx = { workspace_id: WS, cap: "test", project } as const;
      try {
        await services.handlers["project.setup"]?.({
          ...ctx,
          user_id: ALICE,
          source: {
            kind: "clone",
            url: host.url,
            auth: { kind: "token", token: "ghs_isolated-token" },
          },
        });
        const checkout = join(projects, WS, project);
        // Cloned by perch-git, in the workspace's group, and shared.
        expect(statSync(join(checkout, "README.md")).uid).toBe(GIT_UID);
        expect(statSync(join(checkout, "README.md")).gid).toBe(PERCH_GID);
        // Alice changes it and commits as herself; the push goes out as perch-git again.
        await services.handlers["fs.write"]?.({
          ...ctx,
          user_id: ALICE,
          path: "README.md",
          content: "# changed by alice\n",
        });
        await services.handlers["git.commit"]?.({
          ...ctx,
          user_id: ALICE,
          message: "alice's change",
          author: { name: "Alice", email: "alice@perch.test" },
        });
        const pushed = await services.handlers["git.push"]?.({
          ...ctx,
          user_id: ALICE,
          auth: { kind: "token", token: "ghs_isolated-token" },
        });
        expect(pushed).toMatchObject({ pushed: true, branch: "main" });
        const landed = Bun.spawnSync(["git", "--git-dir", host.bare, "log", "-1", "--format=%s"]);
        expect(landed.stdout.toString().trim()).toBe("alice's change");
        // The record of where it came from is the runner's, in the root-owned homes directory.
        expect(statSync(join(homes, ".perch-remotes.json")).uid).toBe(0);
      } finally {
        host.stop();
      }
    }, 60_000);

    test("a project from before isolation is made the workspace's on the runner's start", () => {
      const legacyWs = "0190f2d0-0000-7000-8000-0000000000fe";
      const legacy = join(projects, legacyWs, "0190f2d0-0000-7000-8000-0000000000fd");
      mkdirSync(join(legacy, "src"), { recursive: true, mode: 0o755 });
      writeFileSync(join(legacy, "src", "old.ts"), "old\n", { mode: 0o644 });
      chmodSync(join(legacy, "src", "old.ts"), 0o644);
      for (const path of [
        join(projects, legacyWs),
        legacy,
        join(legacy, "src"),
        join(legacy, "src", "old.ts"),
      ]) {
        chownSync(path, SHARED_UID, PERCH_GID);
        if (!path.endsWith(".ts")) chmodSync(path, 0o755);
      }
      expect(as(BOB, ["sh", "-c", "echo bob >> src/old.ts"], legacy).exitCode).not.toBe(0);
      new Isolation(options()).start(projects);
      expect(statSync(join(projects, legacyWs)).mode & 0o7777).toBe(0o3775);
      expect(statSync(join(legacy, "src")).mode & 0o2070).toBe(0o2070);
      expect(as(BOB, ["sh", "-c", "echo bob >> src/old.ts"], legacy).exitCode).toBe(0);
    });
  },
);

describe.skipIf(!rootOnLinux)(
  "a runner that is not isolated keeps its token out of /proc (root on Linux only, to be another uid)",
  () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "perch-undumpable-"));
      chmodSync(dir, 0o755);
      const identity = join(import.meta.dir, "..", "src", "identity.ts");
      writeFileSync(
        join(dir, "runner.ts"),
        [
          `import { makeUndumpable } from ${JSON.stringify(identity)};`,
          'if (process.argv[2] === "protect" && !makeUndumpable()) process.exit(3);',
          'console.log("READY");',
          "await Bun.sleep(20_000);",
        ].join("\n"),
      );
    });
    afterAll(() => removeTree(dir));

    /** A stand-in local runner: its own uid, a token in its environment, a child of the same uid. */
    async function tokenVisible(protect: boolean): Promise<boolean> {
      const uid = "--reuid=20500";
      const drop = ["setpriv", uid, "--regid=1000", "--clear-groups", "--"];
      const runner = Bun.spawn(
        [...drop, process.execPath, join(dir, "runner.ts"), protect ? "protect" : "plain"],
        {
          env: { PATH, HOME: dir, PERCH_RUNNER_TOKEN: "prt_local-runner-token" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const reader = runner.stdout.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("READY");
        // What a shell or an agent the runner started could do: read its parent's environment.
        const peek = Bun.spawnSync([...drop, "cat", `/proc/${runner.pid}/environ`], {
          env: { PATH },
          stdout: "pipe",
          stderr: "pipe",
        });
        return peek.stdout.toString().includes("prt_local-runner-token");
      } finally {
        runner.kill();
      }
    }

    test("without it, a child of the same uid reads the token; with it, it cannot", async () => {
      expect(await tokenVisible(false)).toBe(true);
      expect(await tokenVisible(true)).toBe(false);
    }, 30_000);
  },
);

describe.skipIf(rootOnLinux)("members on a hosted runner (root on Linux only)", () => {
  test("skipped: switching uids needs a root test process on Linux; there every test above runs", () => {
    expect(rootOnLinux).toBe(false);
  });
});
