# @perch/runner

The runner agent (spec §3.2, §7.6): the control channel client (`connectRunner`), the in-process runner
laptop mode attaches without a socket, and the method handlers the Phase 1 tasks fill in (fs, git, pty,
sessions, ports, previews, exec). `src/main.ts` is the hosted entrypoint the runner image runs.

- `bun test apps/runner`: the client against a stand-in api (register, heartbeats, capability tokens,
  owner-only access, reconnects) and the in-process runner.
- `docs/runners.md` describes the channel, tokens, and hosted-mode environment.
