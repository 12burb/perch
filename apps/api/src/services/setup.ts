/**
 * The setup wizard (spec §8, task 0.13): the first run creates the instance admin, their workspace,
 * confirms PERCH_PUBLIC_URL, and records the telemetry choice in instance_settings. Sign-ups are
 * refused until setup completes so nobody else can claim the admin seat (ADR-0057).
 */
import type { Bus } from "@perch/bus";
import { type Db, type InstanceSettingValue, schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Auth } from "../auth/auth.ts";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { findUserByAuthUserId } from "../repos/users.ts";
import { ensureProfile } from "./users.ts";
import { createWorkspace } from "./workspaces.ts";

const { instanceSettings } = schema;

export const SETTING_KEYS = {
  setupCompleted: "setup.completed",
  instanceId: "instance.id",
  adminUserId: "instance.admin_user_id",
  telemetry: "telemetry.enabled",
  publicUrl: "instance.public_url",
} as const;

export async function getSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  return row ? (row.value as T) : undefined;
}

export async function setSetting(db: Db, key: string, value: InstanceSettingValue): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value } });
}

export async function isSetupComplete(db: Db): Promise<boolean> {
  return (await getSetting<boolean>(db, SETTING_KEYS.setupCompleted)) === true;
}

/** The random instance id (telemetry.md): created on first read, never derived from anything. */
export async function instanceId(db: Db): Promise<string> {
  const existing = await getSetting<string>(db, SETTING_KEYS.instanceId);
  if (existing) return existing;
  const id = Bun.randomUUIDv7();
  await setSetting(db, SETTING_KEYS.instanceId, id);
  return id;
}

export type SetupInput = {
  admin: { name: string; email: string; password: string };
  workspace: { name: string };
  publicUrl: string;
  telemetry: boolean;
};

export type SetupResult = { userId: string; workspaceSlug: string; headers: Headers };

/**
 * Runs the wizard's single step. `publicUrl` must equal the configured PERCH_PUBLIC_URL: the value is
 * an environment fact (passkeys, callbacks, links depend on it), so the wizard confirms it rather than
 * overriding it.
 */
export async function completeSetup(
  deps: { db: Db; bus: Bus; auth: Auth; publicUrl: string },
  input: SetupInput,
): Promise<SetupResult> {
  if (await isSetupComplete(deps.db)) throw PerchError.conflict("setup is already complete");
  if (input.publicUrl.replace(/\/$/, "") !== deps.publicUrl) {
    throw PerchError.validation("PERCH_PUBLIC_URL must match the configured instance URL", {
      configured: deps.publicUrl,
      hint: "Change PERCH_PUBLIC_URL in .env and restart, or confirm the configured value.",
    });
  }
  const signedUp = await deps.auth.api.signUpEmail({
    body: { name: input.admin.name, email: input.admin.email, password: input.admin.password },
    returnHeaders: true,
  });
  const authUserId = signedUp.response.user.id;
  const profile =
    (await findUserByAuthUserId(deps.db, authUserId)) ??
    (await ensureProfile(deps.db, {
      authUserId,
      email: input.admin.email,
      name: input.admin.name,
    }));
  const by: ActorContext = { actor: { type: "user", id: profile.id }, meta: {} };
  const workspace = await createWorkspace(deps.db, deps.bus, { name: input.workspace.name, by });
  await instanceId(deps.db);
  await setSetting(deps.db, SETTING_KEYS.adminUserId, profile.id);
  await setSetting(deps.db, SETTING_KEYS.telemetry, input.telemetry);
  await setSetting(deps.db, SETTING_KEYS.publicUrl, deps.publicUrl);
  await setSetting(deps.db, SETTING_KEYS.setupCompleted, true);
  return { userId: profile.id, workspaceSlug: workspace.slug, headers: signedUp.headers };
}
