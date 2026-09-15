/**
 * Connections and their grants (spec §6 connections, connection_grants, oauth_clients; task 1.16).
 * The ciphertext never leaves this file except to the vault: every read a caller gets goes through
 * the service, which strips it.
 */
import {
  type Connection,
  type ConnectionGrant,
  type ConnectionKind,
  type ConnectionMetadata,
  type ConnectionOwner,
  type ConnectionStatus,
  type Db,
  type GrantSubject,
  type OauthClient,
  schema,
} from "@perch/db";
import { and, asc, eq, isNull, or } from "drizzle-orm";

const { connectionGrants, connections, oauthClients } = schema;

export async function insertConnection(
  db: Db,
  values: {
    workspaceId: string;
    ownerType: ConnectionOwner;
    ownerId: string;
    provider: string;
    kind: ConnectionKind;
    ciphertext: Uint8Array;
    scopes: string[];
    expiresAt: Date | null;
    metadata: ConnectionMetadata;
  },
): Promise<Connection> {
  const [row] = await db.insert(connections).values(values).returning();
  if (!row) throw new Error("insert connections returned no row");
  return row;
}

/** Everything the person may use here: the workspace's shared connections plus their own. */
export function listConnections(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<Connection[]> {
  return db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        or(
          eq(connections.ownerType, "workspace"),
          and(eq(connections.ownerType, "user"), eq(connections.ownerId, userId)),
        ),
      ),
    )
    .orderBy(asc(connections.provider), asc(connections.createdAt));
}

export async function getConnection(db: Db, id: string): Promise<Connection | null> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
  return row ?? null;
}

export async function setConnectionStatus(
  db: Db,
  id: string,
  status: ConnectionStatus,
  metadata?: ConnectionMetadata,
): Promise<void> {
  await db
    .update(connections)
    .set({ status, ...(metadata ? { metadata } : {}), updatedAt: new Date() })
    .where(eq(connections.id, id));
}

/** After a refresh: a new secret, a new expiry, and the moment it happened. */
export async function updateConnectionSecret(
  db: Db,
  id: string,
  values: { ciphertext: Uint8Array; expiresAt: Date | null; scopes?: string[] },
): Promise<void> {
  await db
    .update(connections)
    .set({
      ciphertext: values.ciphertext,
      expiresAt: values.expiresAt,
      ...(values.scopes ? { scopes: values.scopes } : {}),
      status: "active",
      lastRefreshedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(connections.id, id));
}

export async function deleteConnection(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(connections)
    .where(eq(connections.id, id))
    .returning({ id: connections.id });
  return rows.length > 0;
}

export function listGrants(db: Db, connectionId: string): Promise<ConnectionGrant[]> {
  return db
    .select()
    .from(connectionGrants)
    .where(eq(connectionGrants.connectionId, connectionId))
    .orderBy(asc(connectionGrants.createdAt));
}

export async function upsertGrant(
  db: Db,
  values: {
    connectionId: string;
    subjectType: GrantSubject;
    subjectId: string;
    allowedTools: string[] | null;
    channels: string[] | null;
    obo: boolean;
    grantedBy: string;
  },
): Promise<ConnectionGrant> {
  const [row] = await db
    .insert(connectionGrants)
    .values(values)
    .onConflictDoUpdate({
      target: [
        connectionGrants.connectionId,
        connectionGrants.subjectType,
        connectionGrants.subjectId,
      ],
      set: {
        allowedTools: values.allowedTools,
        channels: values.channels,
        obo: values.obo,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("upsert connection_grants returned no row");
  return row;
}

export async function deleteGrant(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(connectionGrants)
    .where(eq(connectionGrants.id, id))
    .returning({ id: connectionGrants.id });
  return rows.length > 0;
}

/** The app registered for this provider: the workspace's own, else the instance-wide one. */
export async function findOauthClient(
  db: Db,
  workspaceId: string,
  provider: string,
): Promise<OauthClient | null> {
  const rows = await db
    .select()
    .from(oauthClients)
    .where(
      and(
        eq(oauthClients.provider, provider),
        or(eq(oauthClients.workspaceId, workspaceId), isNull(oauthClients.workspaceId)),
      ),
    );
  // A workspace's own app wins over the instance's.
  return rows.find((row) => row.workspaceId === workspaceId) ?? rows[0] ?? null;
}

export async function upsertOauthClient(
  db: Db,
  values: {
    workspaceId: string | null;
    provider: string;
    clientId: string;
    ciphertextSecret: Uint8Array | null;
    redirectUri: string;
  },
): Promise<OauthClient> {
  const [row] = await db
    .insert(oauthClients)
    .values(values)
    .onConflictDoUpdate({
      target: [oauthClients.workspaceId, oauthClients.provider],
      set: {
        clientId: values.clientId,
        ciphertextSecret: values.ciphertextSecret,
        redirectUri: values.redirectUri,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("upsert oauth_clients returned no row");
  return row;
}

export function listOauthClients(db: Db, workspaceId: string): Promise<OauthClient[]> {
  return db
    .select()
    .from(oauthClients)
    .where(or(eq(oauthClients.workspaceId, workspaceId), isNull(oauthClients.workspaceId)))
    .orderBy(asc(oauthClients.provider));
}
