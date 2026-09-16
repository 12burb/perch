/**
 * The MCP servers a workspace has written down (spec §6 `mcp_servers`; task 3.24). Today that is
 * the stdio ones a runner hosts: a connection needs no row, because the connection is the row.
 */
import type { Db, McpCommand, McpServer } from "@perch/db";
import { schema } from "@perch/db";
import { and, eq } from "drizzle-orm";

const { mcpServers } = schema;

export async function insertMcpServer(
  db: Db,
  input: {
    workspaceId: string;
    projectId: string;
    name: string;
    command: McpCommand;
  },
): Promise<McpServer> {
  const [row] = await db
    .insert(mcpServers)
    .values({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      name: input.name,
      command: input.command,
      transport: "stdio",
    })
    .returning();
  if (!row) throw new Error("the mcp server was not written");
  return row;
}

export async function getMcpServer(db: Db, id: string): Promise<McpServer | null> {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  return row ?? null;
}

/** A workspace's stdio servers, or one project's when a project is named. */
export async function listMcpServers(
  db: Db,
  workspaceId: string,
  projectId?: string,
): Promise<McpServer[]> {
  return db
    .select()
    .from(mcpServers)
    .where(
      projectId
        ? and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.projectId, projectId))
        : eq(mcpServers.workspaceId, workspaceId),
    )
    .orderBy(mcpServers.name);
}

export async function deleteMcpServer(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(mcpServers).where(eq(mcpServers.id, id)).returning();
  return rows.length > 0;
}

/** What the server last said it could do, so a list is cheap and a stopped runner is not a blank. */
export async function rememberTools(
  db: Db,
  id: string,
  tools: McpServer["toolCache"],
): Promise<void> {
  await db
    .update(mcpServers)
    .set({ toolCache: tools, lastSyncedAt: new Date() })
    .where(eq(mcpServers.id, id));
}
