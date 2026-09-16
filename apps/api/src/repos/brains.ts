/**
 * Credentials and model profiles (spec §6 provider_credentials, model_profiles; task 1.15). The
 * ciphertext never leaves this file except to the vault: every read a caller gets goes through the
 * service, which strips it.
 */
import {
  type CredentialKind,
  type CredentialScope,
  type CredentialStatus,
  type Db,
  type ModelProfile,
  type ProfileDefault,
  type ProviderCredential,
  schema,
} from "@perch/db";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

const { modelProfiles, providerCredentials } = schema;

export async function insertCredential(
  db: Db,
  values: {
    workspaceId: string;
    scope: CredentialScope;
    ownerId: string;
    provider: string;
    kind: CredentialKind;
    ciphertext: Uint8Array;
    label: string;
    hint: string | null;
    baseUrl: string | null;
  },
): Promise<ProviderCredential> {
  const [row] = await db.insert(providerCredentials).values(values).returning();
  if (!row) throw new Error("insert provider_credentials returned no row");
  return row;
}

/** Everything the person may use here: the workspace's shared credentials plus their own. */
export function listCredentials(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<ProviderCredential[]> {
  return db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, workspaceId),
        or(
          eq(providerCredentials.scope, "workspace"),
          and(eq(providerCredentials.scope, "user"), eq(providerCredentials.ownerId, userId)),
        ),
      ),
    )
    .orderBy(asc(providerCredentials.provider), asc(providerCredentials.label));
}

export async function getCredential(db: Db, id: string): Promise<ProviderCredential | null> {
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.id, id))
    .limit(1);
  return row ?? null;
}

export async function setCredentialStatus(
  db: Db,
  id: string,
  status: CredentialStatus,
): Promise<void> {
  await db
    .update(providerCredentials)
    .set({ status, updatedAt: new Date() })
    .where(eq(providerCredentials.id, id));
}

export async function deleteCredential(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(providerCredentials)
    .where(eq(providerCredentials.id, id))
    .returning({ id: providerCredentials.id });
  return rows.length > 0;
}

export async function insertProfile(
  db: Db,
  values: {
    workspaceId: string;
    name: string;
    provider: string;
    modelId: string;
    credentialId: string | null;
    defaultFor: ProfileDefault | null;
    /** The profiles to try when this one will not answer, by name (task 4.1). */
    fallbacks?: string[];
  },
): Promise<ModelProfile> {
  const [row] = await db.insert(modelProfiles).values(values).returning();
  if (!row) throw new Error("insert model_profiles returned no row");
  return row;
}

export function listProfiles(db: Db, workspaceId: string): Promise<ModelProfile[]> {
  return db
    .select()
    .from(modelProfiles)
    .where(eq(modelProfiles.workspaceId, workspaceId))
    .orderBy(asc(modelProfiles.name));
}

export async function getProfile(db: Db, id: string): Promise<ModelProfile | null> {
  const [row] = await db.select().from(modelProfiles).where(eq(modelProfiles.id, id)).limit(1);
  return row ?? null;
}

export async function deleteProfile(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(modelProfiles)
    .where(eq(modelProfiles.id, id))
    .returning({ id: modelProfiles.id });
  return rows.length > 0;
}

/** Hands the title to one profile: only one per workspace may be the default for a kind. */
export async function makeDefault(
  db: Db,
  workspaceId: string,
  id: string,
  defaultFor: ProfileDefault,
): Promise<ModelProfile | null> {
  return db.transaction(async (tx) => {
    await tx
      .update(modelProfiles)
      .set({ defaultFor: null, updatedAt: new Date() })
      .where(
        and(eq(modelProfiles.workspaceId, workspaceId), eq(modelProfiles.defaultFor, defaultFor)),
      );
    const [row] = await tx
      .update(modelProfiles)
      .set({ defaultFor, updatedAt: new Date() })
      .where(and(eq(modelProfiles.id, id), eq(modelProfiles.workspaceId, workspaceId)))
      .returning();
    return row ?? null;
  });
}

/** The workspace's default profile for a kind, when it has one. */
export async function defaultProfile(
  db: Db,
  workspaceId: string,
  defaultFor: ProfileDefault,
): Promise<ModelProfile | null> {
  const [row] = await db
    .select()
    .from(modelProfiles)
    .where(
      and(eq(modelProfiles.workspaceId, workspaceId), eq(modelProfiles.defaultFor, defaultFor)),
    )
    .limit(1);
  return row ?? null;
}

/** Profiles that point at a credential about to go away, so the caller can say what breaks. */
export function profilesUsing(db: Db, credentialId: string): Promise<ModelProfile[]> {
  return db.select().from(modelProfiles).where(eq(modelProfiles.credentialId, credentialId));
}

/** Profiles with no credential run on whatever the engine is configured with (spec §3.6 lanes B, C). */
export function enginesOwnProfiles(db: Db, workspaceId: string): Promise<ModelProfile[]> {
  return db
    .select()
    .from(modelProfiles)
    .where(and(eq(modelProfiles.workspaceId, workspaceId), isNull(modelProfiles.credentialId)))
    .orderBy(sql`${modelProfiles.name} asc`);
}
