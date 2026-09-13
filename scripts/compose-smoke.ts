#!/usr/bin/env bun
/**
 * The compose smoke (spec §8, task 0.13's "fresh VM" criterion in CI): against a running stack, the
 * instance reports setup incomplete, the wizard endpoint creates the admin, and the admin signs in and
 * reads /api/me and the workspace. Usage: bun scripts/compose-smoke.ts http://localhost
 */
const base = (process.argv[2] ?? "http://localhost").replace(/\/$/, "");

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
console.log("compose smoke: setup, sign-in, /api/me, workspace, and the web app all answer");
