/**
 * `perch dev` (spec §2 laptop mode): api + web + the in-process runner on PGlite under ~/.perch. No
 * Docker, no Postgres; the master key is generated on first run; the setup wizard runs once in the
 * browser. Binds 127.0.0.1 unless --host says otherwise. The boot itself lives in ../laptop.ts, shared
 * with the desktop app.
 */
import { parseArgs } from "node:util";
import { laptopPort, startLaptop } from "../laptop.ts";

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
  const port = laptopPort(values.port);
  if (port === null) {
    console.error(`bad port: ${values.port}`);
    return 2;
  }
  const laptop = await startLaptop({
    dataDir: values["data-dir"],
    port,
    host: values.host,
    publicUrl: values["public-url"],
    logLevel: values["log-level"],
  });
  console.log(
    `perch dev: ${laptop.url}\n  data: ${laptop.dataDir}\n  runner: ${laptop.runnerName}`,
  );
  await new Promise<void>((resolve) => {
    const stop = async () => {
      await laptop.stop();
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
  return 0;
}
