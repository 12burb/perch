#!/usr/bin/env bun
/**
 * The compose smoke (spec §8, task 0.13's "fresh VM" criterion in CI): against a running stack, the
 * instance reports setup incomplete, the wizard endpoint creates the admin, and the admin signs in and
 * reads /api/me and the workspace.
 *
 * With `--since <epoch ms>` it also times one leg of the launch bar (task 4.13): from the moment
 * the workflow ran `docker compose up` to a signed-in admin, which is the first of a stranger's two
 * ways in. The workflow supplies the start, because the clock starts before this script does.
 *
 * Usage: bun scripts/compose-smoke.ts http://localhost [--since 1700000000000]
 */
import { within } from "./launch-bar.ts";

const base = (process.argv[2] ?? "http://localhost").replace(/\/$/, "");
const sinceAt = process.argv.indexOf("--since");
const since = sinceAt === -1 ? null : Number(process.argv[sinceAt + 1]);

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const before = await json<{ setup_complete: boolean; mode: string }>(
  await fetch(`${base}/api/instance`),
);
if (before.setup_complete) throw new Error("expected a fresh instance");
if (before.mode !== "team") throw new Error(`expected team mode, got ${before.mode}`);

const setup = await fetch(`${base}/api/setup`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({
    admin: {
      name: "Smoke Admin",
      email: "admin@example.test",
      password: "correct horse battery staple",
    },
    workspace: { name: "Smoke" },
    public_url: base,
    telemetry: false,
  }),
});
if (setup.status !== 201) throw new Error(`setup failed: ${setup.status} ${await setup.text()}`);

const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email: "admin@example.test", password: "correct horse battery staple" }),
});
if (signIn.status !== 200)
  throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(";")[0] ?? "")
  .join("; ");
const me = await json<{ email: string }>(await fetch(`${base}/api/me`, { headers: { cookie } }));
if (me.email !== "admin@example.test") throw new Error(`unexpected /api/me: ${JSON.stringify(me)}`);
const workspaces = await json<{ workspaces: Array<{ slug: string; role: string }> }>(
  await fetch(`${base}/api/workspaces`, { headers: { cookie } }),
);
if (workspaces.workspaces[0]?.slug !== "smoke" || workspaces.workspaces[0]?.role !== "owner") {
  throw new Error(`unexpected workspaces: ${JSON.stringify(workspaces)}`);
}
const web = await fetch(`${base}/`);
if (!(await web.text()).includes('<div id="root">')) throw new Error("the web app is not served");

// A backup, taken through the endpoint the instance's admin uses (task 4.4). The workflow then
// restores it into an empty database, which is the half no request can prove.
const taken = await fetch(`${base}/api/admin/backup`, {
  method: "POST",
  headers: { cookie, origin: base },
});
if (taken.status !== 201) throw new Error(`backup failed: ${taken.status} ${await taken.text()}`);
const backup = await json<{ id: string; rows: number; tables: number }>(taken);
if (backup.rows < 1) throw new Error(`a backup with no rows: ${JSON.stringify(backup)}`);
const backups = await json<{ directory: string; backups: Array<{ id: string }> }>(
  await fetch(`${base}/api/admin/backup`, { headers: { cookie } }),
);
if (!backups.backups.some((one) => one.id === backup.id)) {
  throw new Error(`the backup is not listed: ${JSON.stringify(backups)}`);
}

console.log(
  `compose smoke: setup, sign-in, /api/me, workspace, the web app, and a backup (${backup.id}, ${backup.rows} rows in ${backups.directory}) all answer`,
);

// The launch bar's first leg, measured where it happens (task 4.13).
if (since !== null && Number.isFinite(since)) within("compose-up", Date.now() - since);
