/**
 * A stand-in GitHub (tasks 1.16, 1.20, 1.22): git's smart HTTP protocol over `git http-backend`,
 * plus the three REST endpoints Perch asks for — who a token speaks as, an installation token for
 * an app, and opening a pull request.
 *
 * Nothing here is a mock of Perch's own code: the clone, the push and the pull request all really
 * happen, against a repository on disk and credentials the caller can read back out of `seen`.
 * That is the point — a test can prove which credential went out, and that the one Perch keeps
 * never did.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StandInGitHub = {
  /** The API base: `/user`, `/repos/{owner}/{repo}/pulls`, and `/git/...` all live here. */
  url: string;
  /** The clone URL, shaped so the pull-request route can read an owner and a repo off it. */
  repoUrl: string;
  /** The personal access token this stand-in accepts, and the one an app installation mints. */
  token: string;
  installationToken: string;
  /** The account a token speaks as. */
  login: string;
  /** The bare repository behind `repoUrl`, to read what a push landed. */
  bare: string;
  /** Every request it saw, so a test can prove what went out and what did not. */
  seen: { path: string; auth: string | null; method: string }[];
  stop(): void;
};

export type StandInGitHubOptions = {
  /** The files the repository starts with (default: a README). */
  files?: Record<string, string>;
  /** The branch they are committed on (default: main). */
  branch?: string;
  token?: string;
  login?: string;
  /** A fixed port, when something outside this process has to be told where it is. */
  port?: number;
};

function indexOfDoubleCrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

/**
 * `git http-backend` as CGI, which is how a real git host serves the smart protocol. Served under
 * /git/{owner}/{repo} so the pull-request route can read an owner and a repo off the URL.
 */
async function gitHttpBackend(
  request: Request,
  url: URL,
  root: string,
  prefix: string,
): Promise<Response> {
  const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const proc = Bun.spawn(["git", "http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method,
      PATH_INFO: `/origin.git${url.pathname.slice(prefix.length)}`,
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
  // CGI: headers, a blank line, then the body.
  const separator = indexOfDoubleCrlf(out);
  if (separator < 0) return new Response(out, { status: 200 });
  const headers = new Headers();
  let status = 200;
  for (const line of new TextDecoder().decode(out.subarray(0, separator)).split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers.set(name, value);
  }
  return new Response(out.subarray(separator + 4), { status, headers });
}

const PREFIX = "/git/o/r";

/** Starts the stand-in, with a repository already committed on its default branch. */
export async function startStandInGitHub(
  options: StandInGitHubOptions = {},
): Promise<StandInGitHub> {
  const token = options.token ?? "github_pat_11ABCDE0000secret0000wxyz";
  const installationToken = "ghs_minted_for_this_call";
  const login = options.login ?? "octocat";
  const branch = options.branch ?? "main";
  const files = options.files ?? { "README.md": "# origin\n" };

  const root = mkdtempSync(join(tmpdir(), "perch-origin-"));
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  const run = (cwd: string, ...args: string[]) => {
    const out = Bun.spawnSync(["git", ...args], { cwd });
    if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  };
  Bun.spawnSync(["git", "init", "--bare", "-b", branch, bare]);
  Bun.spawnSync(["git", "init", "-b", branch, work]);
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(work, path), content);
  }
  run(work, "config", "user.email", "origin@perch.test");
  run(work, "config", "user.name", "Origin");
  run(work, "add", "-A");
  run(work, "commit", "-m", "first");
  run(work, "remote", "add", "origin", bare);
  run(work, "push", "-u", "origin", branch);
  // A push over HTTP needs this on the receiving end, the way a real host is configured.
  run(bare, "config", "http.receivepack", "true");

  const seen: StandInGitHub["seen"] = [];
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      seen.push({ path: url.pathname, auth, method: request.method });
      // The repository itself, behind the same credentials — so both the clone and the push really
      // happen, with whatever git was handed.
      if (url.pathname.startsWith("/git/")) {
        const basic = auth?.startsWith("Basic ") ? atob(auth.slice(6)) : "";
        const password = basic.slice(basic.indexOf(":") + 1);
        if (password !== installationToken && password !== token) {
          return new Response("no", {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="git"' },
          });
        }
        return gitHttpBackend(request, url, root, PREFIX);
      }
      // The app lane: a JWT signed by the app's key buys an installation token.
      if (url.pathname.endsWith("/access_tokens")) {
        if (!auth?.startsWith("Bearer ey")) {
          return Response.json({ message: "no jwt" }, { status: 401 });
        }
        return Response.json({
          token: installationToken,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          repository_selection: "selected",
        });
      }
      if (url.pathname.endsWith("/pulls") && request.method === "POST") {
        if (auth !== `Bearer ${installationToken}` && auth !== `Bearer ${token}`) {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        return Response.json(
          { number: 7, html_url: "https://github.test/o/r/pull/7" },
          { status: 201 },
        );
      }
      if (url.pathname === "/user") {
        if (auth !== `Bearer ${token}` && auth !== `Bearer ${installationToken}`) {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        return new Response(JSON.stringify({ login }), {
          headers: { "content-type": "application/json", "x-oauth-scopes": "repo, read:org" },
        });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    repoUrl: `${url}${PREFIX}`,
    token,
    installationToken,
    login,
    bare,
    seen,
    stop() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
