import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { unified } from "../src/services/element-edit.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.21: a tweak from the inspector panel, written back to the file it came from. The edit
 * itself is unit-tested in `@perch/inspector`; what this covers is the round trip — the runner
 * really reads the file, the file on disk really changes, and a refusal is a `422` with the reason
 * on it rather than a half-written file.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let cookie = "";
let stranger = "";
let ws = "";
let project = "";

const FILE = "src/app.tsx";
const BEFORE = [
  "export function App() {",
  "  return (",
  '    <div className="p-2 text-sm" data-perch-src="src/app.tsx:4:5">',
  "      hello",
  "    </div>",
  "  );",
  "}",
  "",
].join("\n");

function checkout(): string {
  return join(projectsDir, ws, project);
}

beforeAll(async () => {
  booted = await bootTestApp({});
  projectsDir = mkdtempSync(join(tmpdir(), "perch-tweak-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 120_000);

afterAll(async () => {
  await running.stop();
  rmSync(projectsDir, { recursive: true, force: true });
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: { method?: string; json?: unknown; as?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: init.as ?? cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("it never happened");
}

function source(): string {
  return readFileSync(join(checkout(), FILE), "utf8");
}

describe("direct tweaks (task 3.21)", () => {
  test("a project with a tagged element in it", async () => {
    const stamp = Date.now();
    cookie = await signUp("Robin", `robin-tweak-${stamp}@perch.test`);
    stranger = await signUp("Wren", `wren-tweak-${stamp}@perch.test`);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Tweaks" } })) as {
        body: { id: string };
      }
    ).body.id;
    const made = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "the-site", source: "empty", default_branch: "main" },
    })) as { status: number; text: string; body: { id: string } };
    expect(made.status, made.text).toBe(201);
    project = made.body.id;
    await until(() => existsSync(join(checkout(), ".git")));
    await until(async () => {
      const row = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string };
      };
      return row.body.status === "ready";
    }, 60_000);

    mkdirSync(join(checkout(), "src"), { recursive: true });
    writeFileSync(join(checkout(), FILE), BEFORE);
  }, 180_000);

  test("the acceptance: a tweak in the panel becomes a change in the file, with its diff", async () => {
    const written = (await call(`/api/workspaces/${ws}/projects/${project}/element-edit`, {
      method: "POST",
      json: {
        source: `${FILE}:3:5`,
        class_name: "p-4 text-md",
        text: "hello there",
      },
    })) as {
      status: number;
      text: string;
      body: { path: string; changed: string[]; diff: string };
    };
    expect(written.status, written.text).toBe(200);
    expect(written.body.path).toBe(FILE);
    expect(written.body.changed.sort()).toEqual(["className", "text"]);

    // The file really says it now.
    const after = source();
    expect(after).toContain('className="p-4 text-md"');
    expect(after).toContain("hello there");
    // And nothing else moved: the tag it was found by is still on it.
    expect(after).toContain('data-perch-src="src/app.tsx:4:5"');
    expect(after.split("\n")).toHaveLength(BEFORE.split("\n").length);

    // The diff is the card's: the one file, the lines that changed, both sides.
    expect(written.body.diff).toContain(`--- a/${FILE}`);
    expect(written.body.diff).toContain('-    <div className="p-2 text-sm"');
    expect(written.body.diff).toContain('+    <div className="p-4 text-md"');
  }, 120_000);

  test("it refuses rather than guesses, and leaves the file alone", async () => {
    const before = source();

    // An expression is not a class list this can rewrite.
    writeFileSync(
      join(checkout(), "src", "expr.tsx"),
      "export const A = () => <div className={cn(a)}>hi</div>;\n",
    );
    const expression = (await call(`/api/workspaces/${ws}/projects/${project}/element-edit`, {
      method: "POST",
      json: { source: "src/expr.tsx:1:24", class_name: "p-2" },
    })) as { status: number; text: string };
    expect(expression.status).toBe(422);
    expect(expression.text).toContain("expression");
    expect(readFileSync(join(checkout(), "src", "expr.tsx"), "utf8")).toContain("{cn(a)}");

    // A source that says nothing, and one that points nowhere.
    expect(
      (
        await call(`/api/workspaces/${ws}/projects/${project}/element-edit`, {
          method: "POST",
          json: { source: "not-a-source", text: "x" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(`/api/workspaces/${ws}/projects/${project}/element-edit`, {
          method: "POST",
          json: { source: `${FILE}:99:1`, text: "x" },
        })
      ).status,
    ).toBe(422);

    // None of that touched the file it was pointed at.
    expect(source()).toBe(before);
  }, 120_000);

  test("a stranger cannot edit somebody else's source", async () => {
    const before = source();
    const refused = await call(`/api/workspaces/${ws}/projects/${project}/element-edit`, {
      method: "POST",
      as: stranger,
      json: { source: `${FILE}:3:5`, text: "mine now" },
    });
    expect(refused.status).toBe(404);
    expect(source()).toBe(before);
  }, 60_000);
});

describe("unified", () => {
  test("one changed line, with context around it", () => {
    const diff = unified("a.txt", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(diff).toContain("--- a/a.txt");
    expect(diff).toContain("+++ b/a.txt");
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain(" one");
    expect(diff).toContain(" three");
  });

  test("lines added and removed in different numbers", () => {
    const diff = unified("a.txt", "a\nb\n", "a\nb1\nb2\n");
    expect(diff).toContain("-b");
    expect(diff).toContain("+b1");
    expect(diff).toContain("+b2");
  });
});
