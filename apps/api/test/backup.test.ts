import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@perch/db";
import { generateMasterKey } from "@perch/vault";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { BackupsService } from "../src/services/backups.ts";
import { bootTestApp, TEST_ADMIN } from "../src/testing.ts";

/**
 * Backups you can trust (task 4.4).
 *
 * The acceptance is the second test: a backup taken from one instance restores into an empty one,
 * and the workspace is all there — the same person signs in, the channel and its message are where
 * they were, the uploaded file is beside them, and a vault-encrypted credential still decrypts.
 */

let one: Booted;
let running: RunningServer;
let base = "";
let cookie = "";
let ws = "";
let channelId = "";
let backupsDir = "";
let filesOne = "";
let filesTwo = "";
const masterKey = generateMasterKey();
const secret = "sk-the-one-that-must-survive";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((part) => part.split(";")[0] ?? "")
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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as never };
}

async function signIn(url: string, who = TEST_ADMIN): Promise<string> {
  const res = await fetch(`${url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({ email: who.email, password: who.password }),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

beforeAll(async () => {
  backupsDir = mkdtempSync(join(tmpdir(), "perch-backups-"));
  filesOne = mkdtempSync(join(tmpdir(), "perch-files-one-"));
  filesTwo = mkdtempSync(join(tmpdir(), "perch-files-two-"));
  one = await bootTestApp({
    PERCH_MASTER_KEY: masterKey,
    PERCH_BACKUP_DIR: backupsDir,
    PERCH_FILES_DIR: filesOne,
  });
  running = serve(one, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  cookie = await signIn(base);

  ws = (
    (await call("/api/workspaces", { method: "POST", json: { name: "The Nest" } })).body as {
      id: string;
    }
  ).id;
  channelId = (
    (
      await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { type: "public", name: "general" },
      })
    ).body as { id: string }
  ).id;
  await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, {
    method: "POST",
    json: { blocks: [{ type: "text", text: "we are all here" }] },
  });
  // A credential, so the backup is carrying something only the vault key can read.
  const credential = await call(`/api/workspaces/${ws}/credentials`, {
    method: "POST",
    json: { provider: "openai", kind: "api_key", scope: "workspace", label: "Key", secret },
  });
  expect(credential.status).toBe(201);
  // And a file beside the database.
  writeFileSync(join(filesOne, "hello.txt"), "hi");
}, 120_000);

afterAll(async () => {
  await running?.stop();
  for (const dir of [backupsDir, filesOne, filesTwo]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("backups (task 4.4)", () => {
  test("only the instance's admin may take one, and the directory is the record", async () => {
    const taken = await call("/api/admin/backup", { method: "POST" });
    expect(taken.status).toBe(201);
    const backup = taken.body as { id: string; rows: number; files: number };
    expect(backup.id).toMatch(/^perch-\d{4}-\d{2}-\d{2}T/);
    expect(backup.rows).toBeGreaterThan(0);
    expect(backup.files).toBe(1);
    expect(existsSync(join(backupsDir, backup.id, "database.jsonl.gz"))).toBe(true);
    // The key is fingerprinted, never written, unless the operator asks for it.
    expect(existsSync(join(backupsDir, backup.id, "master.key"))).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(backupsDir, backup.id, "manifest.json"), "utf8"),
    ) as { masterKey: { included: boolean; fingerprint: string } };
    expect(manifest.masterKey.included).toBe(false);
    expect(manifest.masterKey.fingerprint).toHaveLength(16);

    const listed = await call("/api/admin/backup");
    expect(listed.status).toBe(200);
    const body = listed.body as { directory: string; cron: string; backups: { id: string }[] };
    expect(body.directory).toBe(backupsDir);
    expect(body.cron).toBe("0 3 * * *");
    expect(body.backups.map((one) => one.id)).toEqual([backup.id]);

    // Anybody else is refused, however many workspaces of their own they own.
    const signedUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Sam",
        email: "sam@perch.test",
        password: "correct horse battery staple",
      }),
    });
    const theirs = cookiesFrom(signedUp);
    expect((await call("/api/admin/backup", { as: theirs })).status).toBe(403);
    expect((await call("/api/admin/backup", { method: "POST", as: theirs })).status).toBe(403);
  }, 120_000);

  test("retention keeps the newest and removes the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-keep-"));
    try {
      // A clock the test moves, because two backups in the same second would share a name.
      let day = 1;
      const service = new BackupsService({
        env: { ...one.env, backup: { ...one.env.backup, dir, keep: 2 } },
        db: one.db,
        log: one.log,
        version: { version: "test" },
        now: () => new Date(Date.UTC(2026, 0, day, 3)),
      });
      for (day = 1; day <= 4; day += 1) await service.create();
      expect(service.list().map((backup) => backup.id)).toEqual([
        "perch-2026-01-04T03-00-00Z",
        "perch-2026-01-03T03-00-00Z",
      ]);
      expect(existsSync(join(dir, "perch-2026-01-01T03-00-00Z"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("a backup restores into an empty instance and the workspace is all there", async () => {
    const [backup] = one.backups.list();
    expect(backup).toBeDefined();
    if (!backup) return;

    // A second Perch that knows nothing: no setup wizard, no rows, its own files directory.
    const two = await bootTestApp(
      { PERCH_MASTER_KEY: masterKey, PERCH_FILES_DIR: filesTwo },
      { setup: false },
    );
    const secondServer = serve(two, { port: 0, hostname: "127.0.0.1" });
    try {
      const restored = await two.backups.restore(backup.path);
      expect(restored.rows).toBeGreaterThan(0);
      expect(restored.keyMatches).toBe(true);

      // The same person signs in — their account came back with everything else.
      const theirCookie = await signIn(secondServer.url);
      const workspaces = await fetch(`${secondServer.url}/api/workspaces`, {
        headers: { cookie: theirCookie },
      });
      const list = (await workspaces.json()) as { workspaces: { id: string; name: string }[] };
      expect(list.workspaces.map((one) => one.name).sort()).toEqual(["Admin", "The Nest"]);

      const messages = await fetch(
        `${secondServer.url}/api/workspaces/${ws}/channels/${channelId}/messages`,
        { headers: { cookie: theirCookie } },
      );
      const said = (await messages.json()) as { messages: { blocks: { text?: string }[] }[] };
      expect(said.messages.map((m) => m.blocks[0]?.text)).toContain("we are all here");

      // The uploaded file came across too.
      expect(readFileSync(join(filesTwo, "hello.txt"), "utf8")).toBe("hi");

      // And the vault still opens what it was given, because the key is the same key.
      const [credential] = await two.db.db
        .select()
        .from(schema.providerCredentials)
        .where(eq(schema.providerCredentials.workspaceId, ws));
      expect(credential).toBeDefined();
      expect(
        await two.vault.decryptString(
          credential?.ciphertext ?? new Uint8Array(),
          `provider_credential:${ws}`,
        ),
      ).toBe(secret);

      // Restoring on top of a Perch that already has rows is refused, not merged.
      await expect(two.backups.restore(backup.path)).rejects.toThrow(/already has data/);
    } finally {
      // stop() closes the instance it is serving, so there is nothing left to close after it.
      await secondServer.stop();
    }
  }, 180_000);
});
