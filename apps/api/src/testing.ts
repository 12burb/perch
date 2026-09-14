/**
 * Test wiring: a booted app on an in-memory PGlite with a silent logger and a throwaway master key.
 */
import { generateMasterKey } from "@perch/vault";
import { type Booted, type BootOptions, boot } from "./boot.ts";
import { loadEnv } from "./env.ts";
import { silentLogger } from "./logging.ts";
import { completeSetup } from "./services/setup.ts";

export const TEST_ADMIN = {
  name: "Instance Admin",
  email: "admin@perch.test",
  password: "admin-passphrase-for-tests",
} as const;

/**
 * A booted app for tests. Setup is completed with TEST_ADMIN (and a workspace named "Admin") unless
 * `setup: false`, so sign-ups work exactly as they do after the wizard in production.
 */
export async function bootTestApp(
  overrides: Record<string, string> = {},
  options: { setup?: boolean; runnerChannel?: BootOptions["runnerChannel"] } = {},
): Promise<Booted> {
  const env = loadEnv({
    DATABASE_URL: "pglite://memory",
    PERCH_MASTER_KEY: generateMasterKey(),
    PERCH_LOG_LEVEL: "silent",
    PERCH_DATA_DIR: "/tmp/perch-test-data",
    ...overrides,
  });
  const booted = await boot({ env, log: silentLogger(), runnerChannel: options.runnerChannel });
  if (options.setup !== false) {
    await completeSetup(
      { db: booted.db.db, bus: booted.bus, auth: booted.auth, publicUrl: env.publicUrl },
      {
        admin: TEST_ADMIN,
        workspace: { name: "Admin" },
        publicUrl: env.publicUrl,
        telemetry: false,
      },
    );
  }
  return booted;
}
