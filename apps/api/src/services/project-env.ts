/**
 * A project's environment (spec §5.7 "encrypted per-project env; injected into runner, previews,
 * sessions; never into a model context"; task 2.13).
 *
 * A value goes in once and never comes back out to a client: the api answers with the keys and
 * where they came from, and the values themselves only ever leave this process on their way into a
 * runner. The vault seals each one under its own project and key, so a row lifted from the database
 * will not open anywhere else (AGENTS.md §1.6).
 */
import type { Db, Project, ProjectEnvRow, ProjectEnvSource } from "@perch/db";
import type { Redaction } from "@perch/policy";
import type { Vault } from "@perch/vault";
import { PerchError } from "../errors.ts";
import { deleteEnvRows, listEnvRows, upsertEnvRow } from "../repos/project-env.ts";

export type ProjectEnvDeps = { db: Db; vault: Vault };

/** What an environment variable may be called: what a shell will actually pass on. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Sealed under its project and its key: a ciphertext moved to another row will not open. */
function aad(projectId: string, key: string): string {
  return `project-env:${projectId}:${key}`;
}

export type EnvEntry = { key: string; source: ProjectEnvSource; updatedAt: Date };

/** The keys a project has, and nothing else: values never come back over the wire. */
export async function listEnv(deps: ProjectEnvDeps, project: Project): Promise<EnvEntry[]> {
  const rows = await listEnvRows(deps.db, project.id);
  return rows.map((row) => ({ key: row.key, source: row.source, updatedAt: row.updatedAt }));
}

export async function setEnv(
  deps: ProjectEnvDeps,
  project: Project,
  vars: readonly { key: string; value: string; source?: ProjectEnvSource | undefined }[],
): Promise<EnvEntry[]> {
  for (const one of vars) {
    if (!ENV_KEY.test(one.key)) {
      throw PerchError.validation(`${one.key} is not a name an environment can carry`);
    }
  }
  for (const one of vars) {
    const ciphertext = await deps.vault.encrypt(one.value, aad(project.id, one.key));
    await upsertEnvRow(deps.db, {
      projectId: project.id,
      key: one.key,
      ciphertext,
      ...(one.source ? { source: one.source } : {}),
    });
  }
  return listEnv(deps, project);
}

export async function removeEnv(
  deps: ProjectEnvDeps,
  project: Project,
  keys: readonly string[],
): Promise<number> {
  return deleteEnvRows(deps.db, project.id, [...keys]);
}

/**
 * The values themselves, for the one thing they are for: putting them in front of a process on a
 * runner. Nothing that answers a client calls this.
 */
export async function envFor(
  deps: ProjectEnvDeps,
  project: Project,
): Promise<Record<string, string>> {
  const rows = await listEnvRows(deps.db, project.id);
  const env: Record<string, string> = {};
  for (const row of rows) {
    env[row.key] = await open(deps, row);
  }
  return env;
}

/** The same values, as things to take out of anything written down (task 2.13). */
export async function secretsOf(deps: ProjectEnvDeps, project: Project): Promise<Redaction[]> {
  const env = await envFor(deps, project);
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

async function open(deps: ProjectEnvDeps, row: ProjectEnvRow): Promise<string> {
  try {
    return await deps.vault.decryptString(row.ciphertext, aad(row.projectId, row.key));
  } catch {
    // A value this instance cannot open is a value it does not have: never a broken session.
    return "";
  }
}
