/**
 * Socket mode (spec §7.3 "Events via wss:///api/bot/socket or HMAC-signed webhook"; task 2.19).
 *
 * A bot connects with its own token and is told what happens where it is installed. There is no
 * subscribe op: a bot's subscription is its installs, decided by the people who put it in a channel,
 * and a socket that could ask for more than that would be a second permission system.
 *
 * The transport subscribes to `@perch/bots`' seam rather than the bus, and asks `deliversTo` who
 * hears what, so any transport added later sees exactly the same events in the same shape. The
 * socket is the only one: §7.3's HMAC-signed webhook is not built (ADR-0176).
 */
import { type BotEvent, deliversTo } from "@perch/bots";
import type { Context } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import type { WsServer } from "./server.ts";

type Socket = { send: (data: string) => void; close: (code?: number, reason?: string) => void };

/** One open socket: the bot it speaks for, and the workspace that bot belongs to. */
type Connected = { botId: string; workspaceId: string; ws: Socket };

export type BotSocketServer = {
  handler: WsServer["handler"];
  /** Connected bots, for /api/health and tests. */
  readonly size: number;
  close: () => void;
};

export function createBotSocket(deps: Deps, ws: WsServer): BotSocketServer {
  const connections = new Map<string, Connected>();

  const stop = deps.botEvents.subscribe((event: BotEvent) => {
    for (const conn of connections.values()) {
      // A workspace's news goes to its own bots only; anything addressed, to the bot it names.
      if (!deliversTo(event, { id: conn.botId, workspaceId: conn.workspaceId })) continue;
      try {
        conn.ws.send(JSON.stringify({ type: event.type, ts: event.ts, payload: event.payload }));
      } catch (error) {
        deps.log.warn({ err: error, botId: conn.botId }, "a bot socket would not take an event");
      }
    }
  });

  const handler = ws.upgradeWebSocket((c: Context<AppEnv>) => {
    // The token is a query parameter because a browser's WebSocket cannot set a header, and an
    // external bot is a program that may be running in one.
    const url = new URL(c.req.url);
    const bearer =
      url.searchParams.get("token") ??
      (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    let id: string | null = null;
    return {
      async onOpen(_evt, socket) {
        const caller = await deps.botApi.caller(bearer).catch(() => null);
        if (!caller) {
          socket.close(1008, "a valid bot token is required");
          return;
        }
        id = Bun.randomUUIDv7();
        connections.set(id, {
          botId: caller.bot.id,
          workspaceId: caller.bot.workspaceId,
          ws: socket as unknown as Socket,
        });
        socket.send(
          JSON.stringify({
            type: "hello",
            ts: new Date().toISOString(),
            payload: {
              bot_id: caller.bot.id,
              handle: caller.bot.handle,
              workspace_id: caller.bot.workspaceId,
              scopes: caller.scopes,
            },
          }),
        );
      },
      onMessage(evt, socket) {
        // The only thing a bot may say on the socket is "still here".
        const raw = typeof evt.data === "string" ? evt.data : "";
        if (raw.includes("ping")) {
          socket.send(JSON.stringify({ type: "pong", ts: new Date().toISOString(), payload: {} }));
        }
      },
      onClose() {
        if (id) connections.delete(id);
        id = null;
      },
    };
  });

  return {
    handler,
    get size() {
      return connections.size;
    },
    close: () => {
      stop();
      for (const conn of connections.values()) conn.ws.close(1001, "api shutting down");
      connections.clear();
    },
  };
}
