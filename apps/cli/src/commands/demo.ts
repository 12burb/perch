/**
 * `perch demo` (task 4.8): laptop mode with something in it.
 *
 * `perch dev` gives a stranger a Perch with no workspace, no channels, no bots and no projects —
 * every screen an empty state. This is the same instance, set up without a wizard and seeded: three
 * channels, two bots from the Forge's own templates, and a project made from a starter stack with
 * its dev server running. Nothing here is a fixture: it all goes through the services a person's
 * clicks go through, so what the demo shows is what the product does.
 *
 * The account it makes is a real one, printed once. Anyone running this on something other than
 * their own machine should change the password, and `--email`/`--password` are there for that.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { listWorkspacesForUser } from "@perch/api/repos/workspaces";
import { projectDeps } from "@perch/api/routes/projects";
import { demoDepsFrom, seedDemo } from "@perch/api/services/demo";
import {
  completeSetup,
  getSetting,
  isSetupComplete,
  SETTING_KEYS,
} from "@perch/api/services/setup";
import { laptopPort, startLaptop } from "../laptop.ts";

const HELP = `perch demo [options]

Runs laptop mode and fills the workspace with channels, bots and a project so there is
something to look at. Safe to run twice: what is already there is left alone.

Options:
  --port <n>          port to listen on (default: PORT or 3000)
  --host <addr>       address to bind (default: 127.0.0.1)
  --data-dir <path>   where PGlite, files, and the master key live (default: ~/.perch-demo)
  --email <address>   the admin account to create on a fresh instance
  --password <text>   its password (default: one generated and printed here)
  --workspace <name>  the workspace to create on a fresh instance (default: Demo)
  --template <id>     the starter stack the demo project is made from (default: bun-api)
  --no-project        seed the channels and the bots but no project
  --log-level <lvl>   trace|debug|info|warn|error|fatal|silent (default: warn)
  -h, --help          show this help`;

/** A password somebody can read off a terminal and type again: no ambiguity, enough entropy. */
export function demoPassword(bytes: Uint8Array = randomBytes(12)): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `perch-${out.slice(0, 6)}-${out.slice(6, 12)}`;
}

export async function runDemo(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "data-dir": { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      workspace: { type: "string" },
      template: { type: "string" },
      "no-project": { type: "boolean" },
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
    dataDir: values["data-dir"] ?? process.env.PERCH_DATA_DIR ?? "~/.perch-demo",
    port,
    host: values.host,
    logLevel: values["log-level"] ?? "warn",
  });
  const booted = laptop.booted;
  const password = values.password ?? demoPassword();
  const email = values.email ?? "demo@perch.local";
  let credentials: { email: string; password: string } | null = null;
  try {
    let workspaceId: string | null = null;
    let userId: string | null = null;
    if (!(await isSetupComplete(booted.db.db))) {
      const setup = await completeSetup(
        {
          db: booted.db.db,
          bus: booted.bus,
          auth: booted.auth,
          publicUrl: booted.env.publicUrl,
        },
        {
          admin: { name: "Demo", email, password },
          workspace: { name: values.workspace ?? "Demo" },
          publicUrl: booted.env.publicUrl,
          telemetry: false,
        },
      );
      credentials = { email, password };
      workspaceId = setup.workspaceId;
      userId = setup.userId;
    } else {
      // An instance that is already set up: the demo goes in the admin's first workspace.
      userId = (await getSetting<string>(booted.db.db, SETTING_KEYS.adminUserId)) ?? null;
      const mine = userId ? await listWorkspacesForUser(booted.db.db, userId) : [];
      workspaceId = mine[0]?.workspace.id ?? null;
    }
    if (!workspaceId || !userId) {
      console.error("this instance has no workspace to seed; sign in and make one first");
      await laptop.stop();
      return 1;
    }
    const result = await seedDemo(demoDepsFrom(projectDeps(booted), booted.bots), {
      workspaceId,
      userId,
      by: { actor: { type: "user", id: userId }, meta: {} },
      project: values["no-project"] !== true,
      ...(values.template ? { templateId: values.template } : {}),
    });
    console.log(
      [
        `perch demo: ${laptop.url}`,
        `  data: ${laptop.dataDir}`,
        credentials
          ? `  sign in: ${credentials.email} / ${credentials.password}`
          : "  sign in: the account you already have",
        `  channels: ${result.channels.map((one) => `#${one.name}`).join(" ")}`,
        `  bots: ${result.bots.map((one) => `@${one.handle}`).join(" ") || "none"}`,
        result.project
          ? `  project: ${result.project.key} (${result.project.status})${
              result.preview?.serving ? ` on port ${result.preview.port}` : ""
            }`
          : "  project: none",
      ].join("\n"),
    );
  } catch (error) {
    console.error(`perch demo: ${error instanceof Error ? error.message : String(error)}`);
    await laptop.stop();
    return 1;
  }
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
