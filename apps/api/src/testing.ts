/**
 * Test wiring: a booted app on an in-memory PGlite with a silent logger and a throwaway master key.
 */
import { generateMasterKey } from "@perch/vault";
import { type Booted, boot } from "./boot.ts";
import { loadEnv } from "./env.ts";
import { silentLogger } from "./logging.ts";

export async function bootTestApp(overrides: Record<string, string> = {}): Promise<Booted> {
  const env = loadEnv({
    DATABASE_URL: "pglite://memory",
    PERCH_MASTER_KEY: generateMasterKey(),
    PERCH_LOG_LEVEL: "silent",
    PERCH_DATA_DIR: "/tmp/perch-test-data",
    ...overrides,
  });
  return boot({ env, log: silentLogger() });
}
