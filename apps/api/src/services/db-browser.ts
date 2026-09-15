/**
 * The database panel (spec §5.5 "Supabase … schema/table browser in the panel, SQL with permission
 * prompt for writes"; task 2.15), read-only by default.
 *
 * Nothing here speaks any vendor's REST API. A provider that has a database has an MCP server with
 * tools for it, and Perch already proxies those with the connection's own token, an allow-list and
 * an audit line (task 1.17). So the panel is the MCP gateway with two tool names read off the
 * manifest — which means the next provider whose MCP server can list tables needs a YAML file, not
 * a release.
 *
 * Read-only is enforced here rather than trusted upstream: a statement that is not plainly a read
 * is refused before the gateway is touched, because "the server is in read-only mode" is a promise
 * somebody else made.
 */
import type { DbManifest, Manifest } from "@perch/connect";
import type { Connection } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import type { ConnectionsService } from "./connections.ts";
import type { McpGateway } from "./mcp.ts";

export type Column = { name: string; type: string; nullable: boolean };
export type Table = { schema: string; name: string; rows: number | null; columns: Column[] };
export type QueryResult = { columns: string[]; rows: Record<string, unknown>[] };

export type DbBrowserDeps = { connections: ConnectionsService; gateway: McpGateway };

/** A statement that only reads. Anything else is refused, whatever the server would have allowed. */
const READ_STARTS = ["select", "with", "explain", "show", "table", "values"];
/**
 * Words that make a statement write, wherever they appear. A CTE can hide an INSERT behind a WITH,
 * so the test is the whole statement and not only how it begins — at the price of refusing a SELECT
 * whose own identifiers spell one of these, which is a trade a read-only panel should take.
 */
const WRITES =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|analyse|merge|refresh|reindex|cluster|lock|comment|reset|set|begin|commit|rollback|savepoint|prepare|execute|listen|notify|discard)\b/i;

/** Comments out, so a write cannot hide behind a line comment or a block one. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export function isReadOnlySql(sql: string): boolean {
  const bare = stripSqlComments(sql)
    .trim()
    .replace(/;+\s*$/, "");
  if (!bare) return false;
  // One statement: a read followed by a write is not a read.
  if (bare.includes(";")) return false;
  const first = bare.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!READ_STARTS.includes(first)) return false;
  return !WRITES.test(bare);
}

/** What the panel can do with this connection, or why it cannot. */
export function dbOf(manifest: Manifest): DbManifest {
  if (!manifest.db) {
    throw PerchError.validation(`${manifest.name} has no database Perch can browse`, {
      provider: manifest.id,
    });
  }
  return manifest.db;
}

/** MCP answers in content blocks; the useful half is the JSON one of them holds. */
export function jsonOf(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return null;
  const row = result as { structuredContent?: unknown; content?: unknown };
  if (row.structuredContent !== undefined) return row.structuredContent;
  if (!Array.isArray(row.content)) return null;
  for (const piece of row.content) {
    if (typeof piece !== "object" || piece === null) continue;
    const block = piece as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      return JSON.parse(block.text) as unknown;
    } catch {
      // A server that answers prose rather than JSON has nothing for the panel to draw.
    }
  }
  return null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** The shapes an MCP server lists tables in, narrowed to the one the panel draws. */
export function readTables(value: unknown): Table[] {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { tables?: unknown } | null)?.tables)
      ? ((value as { tables: unknown[] }).tables as unknown[])
      : [];
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const name = str(row.name ?? row.table_name);
    if (!name) return [];
    const rows = row.rows ?? row.live_rows_estimate ?? row.row_count;
    const columns = Array.isArray(row.columns) ? row.columns : [];
    return [
      {
        schema: str(row.schema ?? row.table_schema, "public"),
        name,
        rows: typeof rows === "number" ? rows : null,
        columns: columns.flatMap((one) => {
          if (typeof one !== "object" || one === null) return [];
          const column = one as Record<string, unknown>;
          const columnName = str(column.name ?? column.column_name);
          if (!columnName) return [];
          return [
            {
              name: columnName,
              type: str(column.format ?? column.data_type ?? column.type, "unknown"),
              nullable: column.is_nullable === true || column.is_nullable === "YES",
            },
          ];
        }),
      },
    ];
  });
}

/** A result set as rows of named values, whichever way the server shaped it. */
export function readRows(value: unknown): QueryResult {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { rows?: unknown } | null)?.rows)
      ? ((value as { rows: unknown[] }).rows as unknown[])
      : [];
  const rows = list.flatMap((entry) =>
    typeof entry === "object" && entry !== null ? [entry as Record<string, unknown>] : [],
  );
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return { columns, rows };
}

export class DbBrowser {
  constructor(private readonly deps: DbBrowserDeps) {}

  /** Every table the connection may see, with its columns. */
  async tables(input: {
    connection: Connection;
    userId: string;
    schemas?: string[] | undefined;
    by: ActorContext;
  }): Promise<Table[]> {
    const db = dbOf(this.deps.connections.manifest(input.connection.provider));
    const schemas = input.schemas?.length ? input.schemas : db.schemas;
    const result = await this.deps.gateway.call({
      connection: input.connection,
      // The panel's own calls are not a session's: the allow-list is this manifest's two tools.
      allowList: [db.tables_tool, db.query_tool],
      tool: db.tables_tool,
      args: { [db.schemas_arg]: schemas },
      by: input.by,
      callerId: input.userId,
    });
    return readTables(jsonOf(result));
  }

  /** One read. A statement that writes never reaches the provider. */
  async query(input: {
    connection: Connection;
    userId: string;
    sql: string;
    by: ActorContext;
  }): Promise<QueryResult> {
    const db = dbOf(this.deps.connections.manifest(input.connection.provider));
    if (!isReadOnlySql(input.sql)) {
      throw new PerchError(
        "policy_violation",
        "the database panel reads; a statement that writes needs a session and a permission prompt",
        { rule: "db.read_only" },
      );
    }
    const result = await this.deps.gateway.call({
      connection: input.connection,
      allowList: [db.tables_tool, db.query_tool],
      tool: db.query_tool,
      args: { [db.query_arg]: input.sql },
      by: input.by,
      callerId: input.userId,
    });
    return readRows(jsonOf(result));
  }
}
