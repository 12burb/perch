import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.6 (ADR-0071): the editor's file routes forward to the project's runner: list, read (text and
 * binary), stat, write (with a project.updated event), search; bad paths are 422, the runner's
 * policy refusal is 451, a project still setting up is 409, and strangers see nothing.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";

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
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as unknown };
}

async function readyProject(cookie: string, ws: string, name: string): Promise<string> {
  const created = (await call(`/api/workspaces/${ws}/projects`, cookie, {
    method: "POST",
    json: { name },
  })) as { body: { id: string } };
  const id = created.body.id;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`, cookie)) as {
      body: { status: string; status_message: string | null };
    };
    if (res.body.status === "ready") return id;
    if (res.body.status === "error" || Date.now() > deadline) {
      throw new Error(`project ${res.body.status}: ${res.body.status_message}`);
    }
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  booted = await bootTestApp({});
  projectsDir = mkdtempSync(join(tmpdir(), "perch-fs-api-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("project files api (task 1.6)", () => {
  test("write, list, read, stat, and search a project's files", async () => {
    const owner = await signUp("Rae", "rae-fs@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Files Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const id = await readyProject(owner.cookie, ws, "Editor");
    const fs = `/api/workspaces/${ws}/projects/${id}/fs`;

    const events: string[] = [];
    booted.bus.subscribe("project.updated", (e) => {
      if (e.payload.projectId === id) events.push((e.payload.changes ?? []).join(","));
    });
    const written = await call(`${fs}/write`, owner.cookie, {
      method: "PUT",
      json: { path: "src/index.ts", content: "export const hello = 1;\n" },
    });
    expect(written).toEqual({ status: 200, body: { bytes: 24 } });
    await call(`${fs}/write`, owner.cookie, {
      method: "PUT",
      json: { path: "README.md", content: "# Editor\n" },
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    await call(`${fs}/write`, owner.cookie, {
      method: "PUT",
      json: { path: "logo.png", content: png.toString("base64"), encoding: "base64" },
    });
    expect(readFileSync(join(projectsDir, ws, id, "src", "index.ts"), "utf8")).toBe(
      "export const hello = 1;\n",
    );
    expect(events).toEqual(["files", "files", "files"]);

    const root = (await call(`${fs}/list`, owner.cookie)) as {
      body: { entries: { name: string; type: string }[] };
    };
    expect(root.body.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      "dir:.git",
      "dir:src",
      "file:logo.png",
      "file:README.md",
    ]);
    const src = (await call(`${fs}/list?path=src`, owner.cookie)) as {
      body: { entries: { name: string }[] };
    };
    expect(src.body.entries.map((e) => e.name)).toEqual(["index.ts"]);

    const text = (await call(`${fs}/read?path=src/index.ts`, owner.cookie)) as { body: unknown };
    expect(text.body).toEqual({
      content: "export const hello = 1;\n",
      encoding: "utf8",
      size: 24,
      truncated: false,
    });
    const image = (await call(`${fs}/read?path=logo.png`, owner.cookie)) as {
      body: { encoding: string; content: string };
    };
    expect(image.body.encoding).toBe("base64");
    expect(Buffer.from(image.body.content, "base64").equals(png)).toBe(true);

    expect((await call(`${fs}/stat?path=src`, owner.cookie)).body).toMatchObject({
      exists: true,
      type: "dir",
    });
    expect((await call(`${fs}/stat?path=nope`, owner.cookie)).body).toEqual({ exists: false });

    const found = (await call(`${fs}/search?q=hello`, owner.cookie)) as {
      body: {
        matches: { path: string; line: number; column: number; text: string }[];
        engine: string;
      };
    };
    expect(found.body.matches).toEqual([
      { path: "src/index.ts", line: 1, column: 14, text: "export const hello = 1;" },
    ]);
    const globbed = (await call(`${fs}/search?q=e&glob=*.md&ignore_case=true`, owner.cookie)) as {
      body: { matches: { path: string }[] };
    };
    expect(globbed.body.matches.map((m) => m.path)).toEqual(["README.md"]);

    // Bad paths never reach the runner; the runner's policy answers 451.
    expect((await call(`${fs}/read?path=../secret`, owner.cookie)).status).toBe(422);
    expect((await call(`${fs}/read?path=/etc/passwd`, owner.cookie)).status).toBe(422);
    const denied = (await call(`${fs}/write`, owner.cookie, {
      method: "PUT",
      json: { path: ".git/config", content: "[core]\n" },
    })) as { status: number; body: { error: { code: string } } };
    expect(denied.status).toBe(451);
    expect(denied.body.error.code).toBe("policy_violation");
    expect(existsSync(join(projectsDir, ws, id, ".git", "config"))).toBe(true);
    expect((await call(`${fs}/read?path=missing.txt`, owner.cookie)).status).toBe(502);

    // A member of another workspace sees nothing.
    const other = await signUp("Sam", "sam-fs@perch.test");
    expect((await call(`${fs}/list`, other.cookie)).status).toBe(404);
  });

  test("a project that is not ready is a conflict", async () => {
    const owner = await signUp("Tam", "tam-fs@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Pending Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    // A clone of a repository that does not exist ends in error and stays unusable.
    const project = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
      method: "POST",
      json: { name: "Broken", repo_url: "https://127.0.0.1:1/nope.git" },
    })) as { body: { id: string } };
    const deadline = Date.now() + 20_000;
    for (;;) {
      const res = (await call(
        `/api/workspaces/${ws}/projects/${project.body.id}`,
        owner.cookie,
      )) as {
        body: { status: string };
      };
      if (res.body.status === "error") break;
      if (Date.now() > deadline) throw new Error("still not failed");
      await Bun.sleep(50);
    }
    const res = await call(
      `/api/workspaces/${ws}/projects/${project.body.id}/fs/list`,
      owner.cookie,
    );
    expect(res.status).toBe(409);
  });
});
