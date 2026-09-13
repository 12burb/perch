/**
 * `perch dev` (spec §2 laptop mode): api + web + the in-process runner on PGlite under ~/.perch. No
 * Docker, no Postgres; the master key is generated on first run; the setup wizard runs once in the
 * browser. Binds 127.0.0.1 unless --host says otherwise.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { boot } from "@perch/api/boot";
import { loadEnv } from "@perch/api/env";
import { serve } from "@perch/api/server";
import { createInProcessRunner } from "@perch/runner";
import { dataDirFrom, laptopLayout, webDistDir } from "../paths.ts";
import { pgliteRuntime } from "../pglite-runtime.ts";
import { webAssets } from "../web-assets.gen.ts";

const HELP = `perch dev [options]

Options:
  --port <n>          port to listen on (default: PORT or 3000; 0 picks a free port)
  --host <addr>       address to bind (default: 127.0.0.1)
  --data-dir <path>   where PGlite, files, and the master key live (default: ~/.perch)
  --public-url <url>  PERCH_PUBLIC_URL when it differs from http://<host>:<port>
  --log-level <lvl>   trace|debug|info|warn|error|fatal|silent (default: info)
  -h, --help          show this help`;

export async function runDev(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "data-dir": { type: "string" },
      "public-url": { type: "string" },
      "log-level": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const layout = laptopLayout(dataDirFrom(values["data-dir"]));
  mkdirSync(layout.files, { recursive: true });
  const host = values.host ?? "127.0.0.1";
  const requestedPort = Number(values.port ?? process.env.PORT ?? 3000);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    console.error(`bad port: ${values.port}`);
    return 2;
  }
  // Port 0 asks the OS for a free port; the env needs a real number, so PERCH_PUBLIC_URL is set after.
  const envPort = requestedPort === 0 ? 3000 : requestedPort;
  const publicUrl =
    values["public-url"] ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${envPort}`;
  const env = loadEnv({
    ...process.env,
    DATABASE_URL: layout.databaseUrl,
    PERCH_DATA_DIR: layout.dataDir,
    PERCH_FILES_DIR: layout.files,
    PERCH_PUBLIC_URL: publicUrl,
    PERCH_RUNNER_MODE: "inprocess",
    PORT: String(envPort),
    HOST: host,
    ...(values["log-level"] ? { PERCH_LOG_LEVEL: values["log-level"] } : {}),
  });
  const webDist = webDistDir();
  const embedded = Object.keys(webAssets).length > 0;
  if (!existsSync(join(webDist, "index.html")) && !embedded) {
    console.error(`no web build at ${webDist}; run \`bun run --filter @perch/web build\` first`);
  }
  const booted = await boot({
    env,
    app: { webDist, ...(embedded ? { webAssets } : {}) },
    pglite: await pgliteRuntime(),
  });
  const runner = createInProcessRunner();
  booted.runners.attach(runner);
  runner.heartbeat();
  const running = serve(booted, { port: requestedPort, hostname: host });
  const url = requestedPort === 0 ? running.url : publicUrl;
  if (requestedPort === 0) {
    // The public URL must carry the real port for passkeys and links: rebind is not possible after
    // boot, so a random port is for smoke tests only.
    booted.log.warn(
      { url },
      "random port: PERCH_PUBLIC_URL does not match; use --port for real work",
    );
  }
  console.log(`perch dev: ${url}\n  data: ${layout.dataDir}\n  runner: ${runner.info.name}`);
  const worker = booted.queue.worker({ queues: ["system"], handlers: {} });
  worker.start();
  await new Promise<void>((resolve) => {
    const stop = async () => {
      await worker.stop();
      await running.stop();
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
  return 0;
}
