/**
 * The setup wizard (spec §8, task 0.13): the first run creates the instance admin, their workspace,
 * confirms PERCH_PUBLIC_URL, and records the telemetry choice in instance_settings. Sign-ups are
 * refused until setup completes so nobody else can claim the admin seat (ADR-0057).
 */
import type { Bus } from "@perch/bus";
import { type Db, type InstanceSettingValue, schema } from "@perch/db";
import { and, eq } from "drizzle-orm";
import type { Auth } from "../auth/auth.ts";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { findUserByAuthUserId } from "../repos/users.ts";
import { ensureProfile } from "./users.ts";
import { createWorkspace } from "./workspaces.ts";

const { instanceSettings } = schema;

export const SETTING_KEYS = {
  setupCompleted: "setup.completed",
  /** Who is running setup right now: an ISO timestamp, written once by whoever got there first. */
  setupClaimed: "setup.claimed",
  instanceId: "instance.id",
  adminUserId: "instance.admin_user_id",
  telemetry: "telemetry.enabled",
  publicUrl: "instance.public_url",
  /** How many days of audit log to keep; 0 (the default) keeps everything (task 4.5). */
  auditRetentionDays: "audit.retention_days",
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

/**
 * Whoever the setup wizard made (task 4.4). Workspace roles say nothing about the instance itself,
 * so the one thing that does — "this is the account this Perch was set up with" — is what guards
 * `/api/admin/*` until task 4.5 gives the instance a roster of its own.
 */
export async function isInstanceAdmin(db: Db, userId: string): Promise<boolean> {
  const admin = await getSetting<string>(db, SETTING_KEYS.adminUserId);
  return admin !== undefined && admin === userId;
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

export type SetupResult = {
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  headers: Headers;
};

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
  // The admin seat goes to whoever claims setup first (ADR-0057, ADR-0172): the check above and
  // the writes below are several awaits apart, so without one atomic claim two wizards could both
  // pass the check, and the last to finish would become the admin.
  const claim = await claimSetup(deps.db);
  if (!claim) throw PerchError.conflict("setup is already under way or complete");
  try {
    return await runSetup(deps, input);
  } catch (error) {
    // A failed attempt gives the seat back, so the operator can try again.
    await releaseSetupClaim(deps.db, claim).catch(() => {});
    throw error;
  }
}

/** How long a claim stands without setup completing before another attempt may take it over. */
export const SETUP_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Claims first-run setup with one conditional insert. Returns the claim (its timestamp) or null
 * when someone else holds it. A claim left behind by a process that died mid-setup is taken over
 * once it is older than SETUP_CLAIM_TTL_MS, again with a compare-and-set, so only one taker wins.
 */
export async function claimSetup(db: Db, now = new Date()): Promise<string | null> {
  const stamp = now.toISOString();
  const inserted = await db
    .insert(instanceSettings)
    .values({ key: SETTING_KEYS.setupClaimed, value: stamp })
    .onConflictDoNothing({ target: instanceSettings.key })
    .returning({ key: instanceSettings.key });
  if (inserted.length > 0) return stamp;
  const held = await getSetting<string>(db, SETTING_KEYS.setupClaimed);
  const heldAt = typeof held === "string" ? Date.parse(held) : Number.NaN;
  if (held === undefined || !(now.getTime() - heldAt > SETUP_CLAIM_TTL_MS)) return null;
  const taken = await db
    .update(instanceSettings)
    .set({ value: stamp })
    .where(
      and(eq(instanceSettings.key, SETTING_KEYS.setupClaimed), eq(instanceSettings.value, held)),
    )
    .returning({ key: instanceSettings.key });
  return taken.length > 0 ? stamp : null;
}

/** Gives back a claim this attempt holds; a claim somebody else has since taken is left alone. */
async function releaseSetupClaim(db: Db, claim: string): Promise<void> {
  await db
    .delete(instanceSettings)
    .where(
      and(eq(instanceSettings.key, SETTING_KEYS.setupClaimed), eq(instanceSettings.value, claim)),
    );
}

async function runSetup(
  deps: { db: Db; bus: Bus; auth: Auth; publicUrl: string },
  input: SetupInput,
): Promise<SetupResult> {
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
  return {
    userId: profile.id,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    headers: signedUp.headers,
  };
}
