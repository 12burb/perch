/**
 * The environment a child of the runner starts from (AGENTS.md §1.6: vault in, gateway out).
 *
 * The runner's own process carries its connect token, and in laptop mode the master key and the
 * session secret too — every one of them a `PERCH_*` variable. Nothing the runner starts may see
 * them: not a project's command, dev server or `postCreateCommand`, not an MCP server, not git (a
 * repository's hooks run with git's environment), not an agent, not a version probe. So every
 * child starts here: the runner's environment with every `PERCH_*` variable blanked, plus what the
 * caller sets on purpose.
 *
 * Blanked rather than dropped, for the reason a shell's is (ADR-0073): the PTY layer merges the
 * runner's real environment underneath what it is given, and one rule for every child is easier
 * to hold than two. `extra` is applied as given — a caller that sets `PERCH_GIT_SECRET` for git's
 * credential helper means to.
 *
 * This keeps the secrets out of a child's *own* environment, and that is all it does. A child that
 * runs as the runner's uid can still read the runner's environment from `/proc/<pid>/environ` —
 * ADR-0160 said nothing the runner starts sees the token, and that was not so. What closes it is
 * who the child runs as (ADR-0171, `identity.ts`): on a hosted runner the agent is root and every
 * child an unprivileged uid, and any other Linux runner makes itself non-dumpable, which puts its
 * `/proc` entries out of its children's reach.
 */
export function childEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = key.startsWith("PERCH_") ? "" : value;
  }
  return { ...env, ...extra };
}
