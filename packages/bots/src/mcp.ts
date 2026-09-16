/**
 * MCP attach, as a model sees it (spec §5.3 "MCP attach (any MCP server)"; task 3.6).
 *
 * The api decides *what* a bot may reach — which connections, which of their tools, which of those
 * need a person — because that is a question about grants. This decides *how* those appear in a
 * turn: one tool each, namespaced so an upstream cannot shadow a native tool, and every answer
 * wrapped as somebody else's words.
 *
 * Nothing here can see a credential. An attached server is a pair of functions the api closed over
 * the gateway with; the token stays in the vault and never enters a bot's context (AGENTS.md §1.6).
 */
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { untrusted } from "./tools.ts";

/** One server a bot may reach this turn, already narrowed by its grant. */
export type AttachedServer = {
  /** What the tools are named after: `mcp__vercel__list_projects`. */
  provider: string;
  tools: { name: string; description?: string | undefined }[];
  /** Whether this tool needs a person to say yes, every time (spec §3.5). */
  needsPerson: (tool: string) => boolean;
  /** Runs it through the gateway, which carries the connection's own token. */
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Asks a person instead, and answers with what to tell whoever was waiting. */
  ask: (tool: string, args: Record<string, unknown>) => Promise<string>;
};

/** What a tool from an attached server is called, so it cannot be mistaken for a native one. */
export function mcpToolName(provider: string, name: string): string {
  return `mcp__${provider}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** An upstream's answer is somebody else's words: a bot reads them, it does not obey them. */
export function wrapResult(provider: string, name: string, result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return untrusted(`${provider}/${name}`, text.slice(0, 8_000));
}

/** The tools these servers contribute to one turn. */
export function mcpTools(servers: readonly AttachedServer[]): ToolSet {
  const set: ToolSet = {};
  for (const server of servers) {
    for (const one of server.tools) {
      const key = mcpToolName(server.provider, one.name);
      const asks = server.needsPerson(one.name);
      set[key] = tool({
        description: `${one.description ?? `${server.provider}: ${one.name}`}${
          asks ? " A person has to approve this one, every time." : ""
        }`,
        /**
         * The upstream published a JSON Schema, not a Zod one, and a bot may legitimately pass
         * anything that server accepts. What it may *call* was decided by the grant before this.
         */
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        execute: async (args: unknown) => {
          const shaped = (args ?? {}) as Record<string, unknown>;
          if (asks) return await server.ask(one.name, shaped);
          return wrapResult(server.provider, one.name, await server.call(one.name, shaped));
        },
      });
    }
  }
  return set;
}
