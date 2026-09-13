/**
 * `perch doctor`: checks a laptop-mode installation and its surroundings and prints one line per
 * check (or JSON with --json). Exit 1 when a required check fails.
 */
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { createDb } from "@perch/db";
import { dataDirFrom, laptopLayout, webDistDir } from "../paths.ts";

export type Check = { name: string; ok: boolean; required: boolean; detail: string };

const MIN_BUN = "1.3.11";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function portFree(port: number, host: string): Promise<boolean> {
  try {
    const server = Bun.serve({ port, hostname: host, fetch: () => new Response("") });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function which(binary: string): Promise<string | null> {
  return Bun.which(binary);
}

export async function collectChecks(options: {
  dataDir: string;
  port: number;
  host: string;
}): Promise<Check[]> {
  const checks: Check[] = [];
  const layout = laptopLayout(options.dataDir);

  checks.push({
    name: "bun",
    ok: compareVersions(Bun.version, MIN_BUN) >= 0,
    required: true,
    detail: `${Bun.version} (need ≥ ${MIN_BUN})`,
  });

  let dataOk = true;
  let dataDetail = layout.dataDir;
  try {
    mkdirSync(layout.dataDir, { recursive: true });
    accessSync(layout.dataDir, constants.W_OK);
  } catch (error) {
    dataOk = false;
    dataDetail = `${layout.dataDir}: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({ name: "data dir writable", ok: dataOk, required: true, detail: dataDetail });

  if (dataOk) {
    try {
      const handle = await createDb({ url: layout.databaseUrl });
      try {
        const result = await handle.migrate();
        checks.push({
          name: "database (PGlite)",
          ok: true,
          required: true,
          detail: `${layout.pglite}: ${result.total} migrations, ${result.applied} applied now`,
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      checks.push({
        name: "database (PGlite)",
        ok: false,
        required: true,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  checks.push({
    name: "master key",
    ok: true,
    required: false,
    detail: existsSync(layout.masterKey)
      ? `${layout.masterKey} (${statSync(layout.masterKey).size} bytes)`
      : "not generated yet (perch dev creates it on first run)",
  });

  checks.push({
    name: `port ${options.port}`,
    ok: await portFree(options.port, options.host),
    required: false,
    detail: (await portFree(options.port, options.host))
      ? "free"
      : "in use (pass --port to perch dev)",
  });

  const web = webDistDir();
  checks.push({
    name: "web build",
    ok: existsSync(web),
    required: false,
    detail: existsSync(web) ? web : `${web} missing: bun run --filter @perch/web build`,
  });

  for (const tool of ["git", "docker"] as const) {
    const path = await which(tool);
    checks.push({
      name: tool,
      ok: path !== null,
      required: false,
      detail:
        path ??
        `not found (${tool === "docker" ? "only needed for team mode" : "needed for projects, Phase 1"})`,
    });
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${c.ok ? "ok  " : c.required ? "FAIL" : "warn"}  ${c.name.padEnd(22)} ${c.detail}`)
    .join("\n");
}

export async function runDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log("perch doctor [--data-dir <path>] [--port <n>] [--host <addr>] [--json]");
    return 0;
  }
  const checks = await collectChecks({
    dataDir: dataDirFrom(values["data-dir"]),
    port: Number(values.port ?? process.env.PORT ?? 3000),
    host: values.host ?? "127.0.0.1",
  });
  console.log(values.json ? JSON.stringify({ checks }, null, 2) : formatChecks(checks));
  return checks.some((c) => c.required && !c.ok) ? 1 : 0;
}
