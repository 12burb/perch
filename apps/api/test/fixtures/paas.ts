/**
 * The two platforms task 2.15 talks to, stood in on this machine: a Vercel whose deployments really
 * move from queued to ready, and a Supabase whose MCP server really lists tables and runs a query.
 *
 * Both are reached the way a self-hosted or enterprise install would be — `api_base` and `mcp_url`
 * on the connection — so there is no test-only seam inside Perch. This environment cannot reach
 * api.vercel.com or mcp.supabase.com, so nothing here claims to have run against either.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type StandInVercel = {
  url: string;
  /** The token it accepts; anything else is refused the way the real one would. */
  token: string;
  /** Every request it saw, with the credential that came with it. */
  seen: { method: string; path: string; auth: string | null }[];
  /** What each deployment was asked for, so a test can prove the ref and target went out. */
  created: { name: string; target: string; ref: string; repo: string; org: string }[];
  /** Make the next read of this deployment say it is ready. */
  finish(id: string, url: string): void;
  stop(): void;
};

export type StandInVercelOptions = {
  /**
   * Finish a build this long after it was asked for, the way a real one finishes on its own. Left
   * out, a deployment only becomes ready when `finish` says so — which is what a unit test wants.
   */
  readyAfterMs?: number;
};

export function startStandInVercel(options: StandInVercelOptions = {}): StandInVercel {
  const token = "vercel-stand-in-token";
  const seen: StandInVercel["seen"] = [];
  const created: StandInVercel["created"] = [];
  const deployments = new Map<
    string,
    { readyState: string; url: string; inspectorUrl: string; at: number }
  >();
  let next = 0;
  // Filled the moment the port is known, which is before anything can be asked for.
  let origin = "";

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      seen.push({ method: request.method, path: url.pathname, auth });
      if (auth !== `Bearer ${token}`) {
        return Response.json({ error: { message: "Not authorized" } }, { status: 403 });
      }
      // The manifest's test path: what a pasted token is checked against.
      if (url.pathname === "/v2/user") return Response.json({ user: { username: "nest" } });

      if (url.pathname === "/v13/deployments" && request.method === "POST") {
        const body = (await request.json()) as {
          name?: string;
          target?: string;
          gitSource?: { org?: string; repo?: string; ref?: string };
        };
        next += 1;
        const id = `dpl_stand_in_${next}`;
        created.push({
          name: String(body.name ?? ""),
          target: String(body.target ?? ""),
          ref: String(body.gitSource?.ref ?? ""),
          repo: String(body.gitSource?.repo ?? ""),
          org: String(body.gitSource?.org ?? ""),
        });
        // A real deploy is not ready when it is asked for, which is the case the card is for.
        deployments.set(id, {
          readyState: "BUILDING",
          url: "",
          inspectorUrl: `${origin}/inspect/${id}`,
          at: Date.now(),
        });
        return Response.json({
          id,
          readyState: "BUILDING",
          inspectorUrl: `${origin}/inspect/${id}`,
        });
      }

      const read = /^\/v13\/deployments\/(?<id>[^/]+)$/.exec(url.pathname);
      if (read?.groups?.id && request.method === "GET") {
        const id = decodeURIComponent(read.groups.id);
        const row = deployments.get(id);
        if (!row) return Response.json({ error: { message: "not found" } }, { status: 404 });
        const done =
          options.readyAfterMs !== undefined && Date.now() - row.at >= options.readyAfterMs;
        const state = done ? "READY" : row.readyState;
        const url = done && !row.url ? `${id.replace(/_/g, "-")}.vercel.test` : row.url;
        return Response.json({
          id,
          readyState: state,
          ...(url ? { url } : {}),
          inspectorUrl: row.inspectorUrl,
        });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });

  origin = `http://127.0.0.1:${server.port}`;

  return {
    url: origin,
    token,
    seen,
    created,
    finish(id, url) {
      const row = deployments.get(id);
      if (row) deployments.set(id, { ...row, readyState: "READY", url });
    },
    stop: () => server.stop(true),
  };
}

export type StandInSupabase = {
  url: string;
  mcpUrl: string;
  token: string;
  /** The tools it was asked to run, with what they were given. */
  called: { tool: string; args: Record<string, unknown> }[];
  stop(): void;
};

/** The two tools connectors/supabase/manifest.yaml names, over real Streamable HTTP MCP. */
function databaseServer(called: StandInSupabase["called"]): Server {
  const server = new Server({ name: "stand-in-db", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_tables",
        description: "Tables in the given schemas",
        inputSchema: { type: "object" as const, properties: { schemas: { type: "array" } } },
      },
      {
        name: "execute_sql",
        description: "Run one statement",
        inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    called.push({ tool: request.params.name, args });
    if (request.params.name === "list_tables") {
      const tables = [
        {
          schema: "public",
          name: "birds",
          live_rows_estimate: 3,
          columns: [
            { name: "id", format: "uuid", is_nullable: false },
            { name: "name", format: "text", is_nullable: false },
          ],
        },
      ];
      return { content: [{ type: "text" as const, text: JSON.stringify(tables) }] };
    }
    const rows = [{ id: "1", name: "swift" }];
    return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
  });
  return server;
}

export function startStandInSupabase(): StandInSupabase {
  const token = "sbp_stand_in_0000000000000000000000";
  const called: StandInSupabase["called"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }
      // The manifest's test path.
      if (url.pathname === "/v1/projects") return Response.json([{ id: "nest", name: "Nest" }]);
      if (url.pathname !== "/mcp") return Response.json({ message: "not found" }, { status: 404 });
      const mcp = databaseServer(called);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      return transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    mcpUrl: `http://127.0.0.1:${server.port}/mcp`,
    token,
    called,
    stop: () => server.stop(true),
  };
}
