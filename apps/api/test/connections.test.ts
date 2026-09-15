import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";
import { type StandInGitHub, startStandInGitHub } from "./fixtures/github.ts";

/**
 * Task 1.16 (spec §3.5): connecting a service. The paste lane and the GitHub App lane both end up
 * as a connection nobody can read back, and the invariant is that no listing, error, or response
 * body ever carries the token or the app's private key — only the account it speaks as and a hint.
 *
 * Both lanes point at a stand-in GitHub on this machine through `api_base`, which is the same
 * field a self-hosted GitHub Enterprise would use: no test-only seam.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let github: StandInGitHub | null = null;
let githubUrl = "";
let projectsDir = "";
/** Where the stand-in serves the repository a clone actually pulls from. */
let originUrl = "";

const TOKEN = "github_pat_11ABCDE0000secret0000wxyz";
/** A throwaway RSA key, generated per run: nothing here is a credential. */
let appKeyPem = "";

/** What the stand-in saw, so the test can prove what went out and what did not. */
let seen: StandInGitHub["seen"] = [];

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return { cookie: cookiesFrom(res) };
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const body = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, "$1\n");
  appKeyPem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;

  github = await startStandInGitHub({ token: TOKEN });
  githubUrl = github.url;
  originUrl = github.repoUrl;
  seen = github.seen;

  booted = await bootTestApp({});
  projectsDir = mkdtempSync(join(tmpdir(), "perch-connections-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  github?.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

type ConnectionBody = {
  id: string;
  provider: string;
  kind: string;
  account: string | null;
  hint: string | null;
  scopes: string[];
  status: string;
};

describe("connections (task 1.16)", () => {
  test("a pasted token and an app installation both connect, and neither comes back", async () => {
    const owner = await signUp("Ada", "ada-conn@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Connect Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;

    // The providers this instance ships, with the URLs a wizard needs prefilled.
    const providers = (await call(`/api/workspaces/${ws}/connection-providers`, owner.cookie)) as {
      status: number;
      body: {
        providers: {
          id: string;
          lanes: string[];
          callback_url: string;
          webhook_url: string;
          token_prefix: string[];
        }[];
      };
    };
    expect(providers.status).toBe(200);
    const github = providers.body.providers.find((p) => p.id === "github");
    expect(github?.lanes).toEqual(["github_app", "oauth2", "token"]);
    expect(github?.callback_url).toMatch(/\/api\/connect\/callback\/github$/);
    expect(github?.webhook_url).toMatch(new RegExp(`/hooks/github/${ws}$`));

    // The paste lane. The token is checked against the provider before it is kept.
    const pasted = (await call(`/api/workspaces/${ws}/connections`, owner.cookie, {
      method: "POST",
      json: { kind: "token", provider: "github", token: TOKEN, api_base: githubUrl },
    })) as { status: number; text: string; body: ConnectionBody };
    expect(pasted.status).toBe(201);
    expect(pasted.body.account).toBe("octocat");
    expect(pasted.body.scopes).toEqual(["repo", "read:org"]);
    expect(pasted.body.hint).toBe("gi…wxyz");
    expect(pasted.text).not.toContain(TOKEN);

    // The app lane. Perch keeps the private key and mints a token per call.
    const app = (await call(`/api/workspaces/${ws}/connections`, owner.cookie, {
      method: "POST",
      json: {
        kind: "github_app",
        provider: "github",
        app_id: "424242",
        private_key: appKeyPem,
        installation_id: "77",
        api_base: githubUrl,
      },
    })) as { status: number; text: string; body: ConnectionBody };
    expect(app.status).toBe(201);
    expect(app.body.kind).toBe("github_app");
    expect(app.body.account).toBe("octocat");
    expect(app.text).not.toContain("PRIVATE KEY");
    expect(seen.some((s) => s.path === "/app/installations/77/access_tokens")).toBe(true);

    // Neither secret is in the listing, and the app's key is not even hinted at.
    const listed = (await call(`/api/workspaces/${ws}/connections`, owner.cookie)) as {
      text: string;
      body: { connections: ConnectionBody[] };
    };
    expect(listed.body.connections).toHaveLength(2);
    expect(listed.text).not.toContain(TOKEN);
    expect(listed.text).not.toContain("PRIVATE KEY");
    expect(listed.body.connections.find((c) => c.kind === "github_app")?.hint).toBeNull();

    // Test asks the provider again; the app lane mints a fresh token to do it.
    const before = seen.filter((s) => s.path.endsWith("/access_tokens")).length;
    const tested = (await call(
      `/api/workspaces/${ws}/connections/${app.body.id}/test`,
      owner.cookie,
      { method: "POST" },
    )) as { status: number; body: { account: string | null; scopes: string[] } };
    expect(tested.status).toBe(200);
    expect(tested.body.account).toBe("octocat");
    expect(seen.filter((s) => s.path.endsWith("/access_tokens")).length).toBe(before + 1);

    // The CIMD document describes this instance, and its URL is the client_id it declares.
    const metadata = (await call("/.well-known/oauth-client-metadata.json", "")) as {
      status: number;
      body: { client_id: string; redirect_uris: string[]; token_endpoint_auth_method: string };
    };
    expect(metadata.status).toBe(200);
    expect(metadata.body.client_id).toMatch(/\/\.well-known\/oauth-client-metadata\.json$/);
    expect(metadata.body.redirect_uris.some((uri) => uri.endsWith("/github"))).toBe(true);
    expect(metadata.body.token_endpoint_auth_method).toBe("none");

    expect(
      (
        await call(`/api/workspaces/${ws}/connections/${pasted.body.id}`, owner.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  }, 60_000);

  test("the acceptance: clone through a GitHub connection, then open a pull request on it", async () => {
    const owner = await signUp("Ren", "ren-conn@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "PR Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;

    const connection = (await call(`/api/workspaces/${ws}/connections`, owner.cookie, {
      method: "POST",
      json: {
        kind: "github_app",
        provider: "github",
        app_id: "424242",
        private_key: appKeyPem,
        installation_id: "77",
        api_base: githubUrl,
      },
    })) as { status: number; body: ConnectionBody };
    expect(connection.status).toBe(201);

    // The clone runs on the connection: Perch mints the token, hands it to the runner for this one
    // clone, and never writes it down.
    const project = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
      method: "POST",
      json: {
        name: "Cloned",
        repo_url: originUrl,
        auth: { kind: "connection", connection_id: connection.body.id },
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(project.status, project.text).toBe(201);
    const projectId = project.body.id;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/workspaces/${ws}/projects/${projectId}`, owner.cookie)) as {
        body: { status: string; status_message: string | null };
      };
      if (res.body.status === "ready") break;
      if (res.body.status === "error" || Date.now() > deadline) {
        throw new Error(`clone ${res.body.status}: ${res.body.status_message}`);
      }
      await Bun.sleep(50);
    }

    // A branch with a change on it, the way a session would leave one. The HTTP routes for these
    // arrive with the git panel (task 1.20), so the test arranges it through the runner directly.
    const link = booted.runners.forWorkspace(ws)[0]?.link;
    if (!link) throw new Error("no runner attached");
    const runner = { workspace_id: ws, user_id: "", project: projectId };
    const me = (await call("/api/me", owner.cookie)) as { body: { id: string } };
    runner.user_id = me.body.id;
    await link.call("git.branch", { ...runner, name: "perch/change", create: true });
    await link.call("fs.write", { ...runner, path: "NOTES.md", content: "a change\n" });
    await link.call("git.commit", {
      ...runner,
      message: "a change",
      author: { name: "Ren", email: "ren-conn@perch.test" },
    });

    // And the pull request, pushed and opened on the same connection.
    const pr = (await call(
      `/api/workspaces/${ws}/projects/${projectId}/pull-request`,
      owner.cookie,
      {
        method: "POST",
        json: { connection_id: connection.body.id, title: "A change", head: "perch/change" },
      },
    )) as { status: number; text: string; body: { number: number; url: string; branch: string } };
    expect(pr.status, pr.text).toBe(201);
    expect(pr.body).toMatchObject({ number: 7, branch: "perch/change" });
    expect(pr.body.url).toBe("https://github.test/o/r/pull/7");
    // The token that did all of this is in none of it.
    expect(pr.text).not.toContain("ghs_minted");
    expect(seen.some((s) => s.path.endsWith("/pulls") && s.method === "POST")).toBe(true);
    // And git really was handed the minted installation token — not a stored one, and not the
    // app's private key. The push is the one that matters: it is a write.
    const pushes = seen.filter((s) => s.path.includes("/git-receive-pack"));
    expect(pushes.length).toBeGreaterThan(0);
    for (const request of pushes) {
      const basic = request.auth?.startsWith("Basic ") ? atob(request.auth.slice(6)) : "";
      expect(basic).toBe("x-access-token:ghs_minted_for_this_call");
    }
  }, 90_000);

  test("a wrong token is refused before it is kept; scope and ownership are enforced", async () => {
    const owner = await signUp("Cal", "cal-conn@perch.test");
    const member = await signUp("Mo", "mo-conn@perch.test");
    const stranger = await signUp("Sid", "sid-conn@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Keys Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, owner.cookie, {
      method: "POST",
      json: { email: "mo-conn@perch.test", role: "member" },
    })) as { status: number; body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, member.cookie, { method: "POST" })).status,
    ).toBe(200);

    // A token the provider refuses never becomes a connection.
    const wrong = await call(`/api/workspaces/${ws}/connections`, owner.cookie, {
      method: "POST",
      json: {
        kind: "token",
        provider: "github",
        token: "github_pat_wrongwrongwrong",
        api_base: githubUrl,
      },
    });
    expect(wrong.status).toBe(502);
    expect(wrong.text).not.toContain("github_pat_wrongwrongwrong");
    expect(
      (
        (await call(`/api/workspaces/${ws}/connections`, owner.cookie)) as {
          body: { connections: unknown[] };
        }
      ).body.connections,
    ).toHaveLength(0);

    // A paste from the wrong field is caught before any request goes out.
    const shaped = await call(`/api/workspaces/${ws}/connections`, owner.cookie, {
      method: "POST",
      json: {
        kind: "token",
        provider: "github",
        token: "sk-not-a-github-token",
        api_base: githubUrl,
      },
    });
    expect(shaped.status).toBe(422);

    // A member may connect their own account, but not one the whole workspace acts through.
    const mine = await call(`/api/workspaces/${ws}/connections`, member.cookie, {
      method: "POST",
      json: { kind: "token", provider: "github", token: TOKEN, api_base: githubUrl },
    });
    expect(mine.status).toBe(201);
    expect(
      (
        await call(`/api/workspaces/${ws}/connections`, member.cookie, {
          method: "POST",
          json: {
            kind: "token",
            provider: "github",
            token: TOKEN,
            owner_type: "workspace",
            api_base: githubUrl,
          },
        })
      ).status,
    ).toBe(403);

    // The owner does not see the member's own connection, and a stranger sees nothing at all.
    const ownerSees = (await call(`/api/workspaces/${ws}/connections`, owner.cookie)) as {
      body: { connections: ConnectionBody[] };
    };
    expect(ownerSees.body.connections.map((c) => c.id)).not.toContain(
      (mine.body as ConnectionBody).id,
    );
    expect((await call(`/api/workspaces/${ws}/connections`, stranger.cookie)).status).toBe(404);
    expect((await call(`/api/workspaces/${ws}/connection-providers`, stranger.cookie)).status).toBe(
      404,
    );
  }, 60_000);
});
