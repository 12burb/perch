/**
 * A git host on this machine for the credentialed-git tests: git's smart HTTP protocol through
 * `git http-backend`, behind Basic auth with one token, the way a real host asks for a credential
 * (401, then the client's helper answers). Every request's Authorization header is kept, so a test
 * can say what reached the host.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitHost = {
  /** `http://127.0.0.1:<port>/repo.git` */
  url: string;
  /** The bare repository behind it. */
  bare: string;
  /** Authorization headers of every request, in order ("" for none). */
  seen: string[];
  stop(): void;
};

function crlfcrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function run(cwd: string, ...args: string[]): void {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
}

export function startGitHost(token: string, username = "x-access-token"): GitHost {
  const root = mkdtempSync(join(tmpdir(), "perch-git-host-"));
  const bare = join(root, "repo.git");
  const work = join(root, "work");
  Bun.spawnSync(["git", "init", "--bare", "-b", "main", bare]);
  Bun.spawnSync(["git", "init", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), "# origin\n");
  run(work, "-c", "user.email=o@perch.test", "-c", "user.name=Origin", "add", "-A");
  run(work, "-c", "user.email=o@perch.test", "-c", "user.name=Origin", "commit", "-m", "first");
  run(work, "push", bare, "main");
  run(bare, "config", "http.receivepack", "true");
  const expected = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization") ?? "";
      seen.push(auth);
      if (!auth) {
        return new Response("credentials, please", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="perch-test"' },
        });
      }
      if (auth !== expected) return new Response("wrong credentials", { status: 403 });
      const body =
        request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined;
      const proc = Bun.spawn(["git", "http-backend"], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          REMOTE_USER: "perch",
          HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
        },
        stdin: body ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (body && proc.stdin) {
        proc.stdin.write(body);
        await proc.stdin.end();
      }
      const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      await proc.exited;
      const split = crlfcrlf(out);
      if (split < 0) return new Response(out);
      const headers = new Headers();
      let status = 200;
      for (const line of new TextDecoder().decode(out.subarray(0, split)).split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
        else headers.set(name, value);
      }
      return new Response(out.subarray(split + 4), { status, headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/repo.git`,
    bare,
    seen,
    stop() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
