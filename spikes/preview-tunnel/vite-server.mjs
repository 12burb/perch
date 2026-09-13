// The "user's dev server" for spike 0.4.9: a Vite dev server bound to 127.0.0.1 on a free port. It runs
// under Node because it stands in for whatever the user's project runs (spec §5.6: the dev server is the
// project's own process); Perch code never depends on it. Prints {port, token} as one JSON line, and exits
// when stdin closes.
import { createServer } from "vite";

const root = process.argv[2];
const server = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen();
const address = server.httpServer?.address();
const port = typeof address === "object" && address ? address.port : 0;
process.stdout.write(`${JSON.stringify({ port, token: server.config.webSocketToken })}\n`);
process.stdin.resume();
process.stdin.on("end", () => server.close().then(() => process.exit(0)));
