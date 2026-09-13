import type { Server } from "bun";
import type { Booted } from "./boot.ts";

export type RunningServer = { server: Server<undefined>; url: string; stop: () => Promise<void> };

/** Bun.serve with the Hono app; WebSocket handlers attach here in task 0.10. */
export function serve(
  booted: Booted,
  options: { port?: number; hostname?: string } = {},
): RunningServer {
  const port = options.port ?? booted.env.port;
  const hostname = options.hostname ?? booted.env.host;
  const server = Bun.serve({
    port,
    hostname,
    fetch: booted.app.fetch,
  });
  const url = `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}`;
  booted.log.info({ url, mode: booted.env.mode, driver: booted.db.driver }, "perch api listening");
  return {
    server,
    url,
    stop: async () => {
      server.stop(true);
      await booted.close();
    },
  };
}
