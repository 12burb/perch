import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { MAX_UPLOAD_BYTES, safeName } from "../src/services/files.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.3 (spec §5.2 "file uploads with previews", §6 `files`, §7.1): what happens to a file.
 * Uploading it, saying it in a channel, getting it back, and — the part that matters — what a
 * browser is allowed to do with it when it comes back (ADR-0093).
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let filesDir = "";
let ws = "";
let channel = "";
let wren = { cookie: "", id: "" };
let mallory = { cookie: "", id: "" };

// A one-pixel PNG, which is a real image and small enough to write out here.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

beforeAll(async () => {
  filesDir = mkdtempSync(join(tmpdir(), "perch-files-"));
  booted = await bootTestApp({ PERCH_FILES_DIR: filesDir });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  rmSync(filesDir, { recursive: true, force: true });
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string } };
  return { cookie, id: me.body.id };
}

type Uploaded = { id: string; name: string; mime: string; size: number; preview: boolean };

async function upload(cookie: string, workspace: string, file: File) {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch(`${base}/api/workspaces/${workspace}/files`, {
    method: "POST",
    headers: { cookie, origin: base },
    body: form,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Uploaded };
}

describe("files (task 2.3)", () => {
  test("a name is only ever a name", () => {
    expect(safeName("notes.md")).toBe("notes.md");
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Windows\\system32\\drivers\\etc\\hosts")).toBe("hosts");
    expect(safeName(`bell${String.fromCharCode(7)}.txt`)).toBe("bell.txt");
    expect(safeName("   ")).toBe("file");
    // A browser posting an empty part sends no filename at all.
    expect(safeName(undefined)).toBe("file");
  });

  test("upload an image, say it in a channel, and get it back", async () => {
    const stamp = Date.now();
    wren = await signUp("Wren", `wren-file-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", wren.cookie, {
      method: "POST",
      json: { name: "File Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const created = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "public", name: "general" },
    })) as { body: { id: string } };
    channel = created.body.id;

    const png = await upload(
      wren.cookie,
      ws,
      new File([PNG], "a pixel.png", { type: "image/png" }),
    );
    expect(png.status).toBe(201);
    expect(png.body).toMatchObject({ name: "a pixel.png", mime: "image/png", preview: true });
    expect(png.body.size).toBe(PNG.byteLength);

    // A message carries the block; the api hands back the file beside it so the client can draw it.
    const said = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: {
        blocks: [
          { type: "file", fileId: png.body.id, text: "the pixel" },
          { type: "text", text: "here it is" },
        ],
      },
    })) as { status: number; body: { files: Uploaded[]; blocks: { type: string }[] } };
    expect(said.status).toBe(201);
    expect(said.body.blocks.map((b) => b.type)).toEqual(["file", "text"]);
    expect(said.body.files).toHaveLength(1);
    expect(said.body.files[0]).toMatchObject({ id: png.body.id, name: "a pixel.png" });

    // The preview is the image, served as itself and never sniffed.
    const preview = await fetch(`${base}/api/files/${png.body.id}/preview`, {
      headers: { cookie: wren.cookie },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preview.headers.get("content-disposition")).toContain("inline");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(PNG);

    // The file itself is always a download, whatever it is.
    const download = await fetch(`${base}/api/files/${png.body.id}`, {
      headers: { cookie: wren.cookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-disposition")).toContain("a pixel.png");
  }, 60_000);

  test("an upload that could run in a browser never does", async () => {
    const svg = await upload(
      wren.cookie,
      ws,
      new File(
        ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
        "x.svg",
        {
          type: "image/svg+xml",
        },
      ),
    );
    expect(svg.status).toBe(201);
    // No preview for a type that carries script: it is a download and nothing else.
    expect(svg.body.preview).toBe(false);
    const preview = await fetch(`${base}/api/files/${svg.body.id}/preview`, {
      headers: { cookie: wren.cookie },
    });
    expect(preview.status).toBe(404);
    const download = await fetch(`${base}/api/files/${svg.body.id}`, {
      headers: { cookie: wren.cookie },
    });
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
  }, 30_000);

  test("a file belongs to its workspace, and to nobody else", async () => {
    const stamp = Date.now();
    mallory = await signUp("Mallory", `mallory-file-${stamp}@perch.test`);
    const theirs = (await call("/api/workspaces", mallory.cookie, {
      method: "POST",
      json: { name: "Other Nest" },
    })) as { body: { id: string } };
    const mine = await upload(
      wren.cookie,
      ws,
      new File(["secret"], "notes.txt", { type: "text/plain" }),
    );
    expect(mine.status).toBe(201);

    // Somebody outside the workspace cannot read it — and is not told it exists (ADR-0090).
    const refused = await fetch(`${base}/api/files/${mine.body.id}`, {
      headers: { cookie: mallory.cookie },
    });
    expect(refused.status).toBe(404);

    // …and cannot point a message in their own workspace at it either.
    const channelOfTheirs = (await call(
      `/api/workspaces/${theirs.body.id}/channels`,
      mallory.cookie,
      { method: "POST", json: { type: "public", name: "general" } },
    )) as { body: { id: string } };
    const borrowed = await call(
      `/api/workspaces/${theirs.body.id}/channels/${channelOfTheirs.body.id}/messages`,
      mallory.cookie,
      { method: "POST", json: { blocks: [{ type: "file", fileId: mine.body.id }] } },
    );
    expect(borrowed.status).toBe(422);
  }, 60_000);

  test("an empty file and one over the limit are both refused", async () => {
    const empty = await upload(
      wren.cookie,
      ws,
      new File([], "nothing.txt", { type: "text/plain" }),
    );
    expect(empty.status).toBe(422);
    const huge = await upload(
      wren.cookie,
      ws,
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.bin", {
        type: "application/octet-stream",
      }),
    );
    expect(huge.status).toBe(422);
  }, 60_000);
});
