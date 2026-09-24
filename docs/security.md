# Security: scanning, SBOMs, signatures, and the disclosure drill

How to report a vulnerability is `SECURITY.md`, at the root, where GitHub looks for it. This page is
the other half: what Perch does to find problems before you do, what a release says about itself,
and the drill that keeps the reporting path from rusting (task 4.9).

## What gets scanned, and when

| When | What | Where |
|---|---|---|
| Every push | The repository's lockfiles (`bun.lock`, `docs/site/bun.lock`) | `ci.yml` → Trivy `fs` |
| Every push | The api image, and the runner image's agents layer | `ci.yml` → Trivy image |
| Every push | Perch's own code, on a pull request | Biome, `tsc`, the route-authorization invariant (`docs/audit.md`) |
| Daily | The same lockfiles, and the images this commit builds | `security.yml` |
| Weekly | Perch's own code, deeply | `codeql.yml` (CodeQL, `security-and-quality`) |

The daily run exists because of the failure mode a per-push scan cannot cover: a dependency that
was fine when it was merged and has an advisory a week later. Nobody has to push for that to turn
something red. It builds the images from the current commit rather than pulling the published
`:latest`: an advisory against the *last release's* image is real, but it is not something a change
to `main` can answer, and a check that stays red between releases is a check people stop reading.
The release's own images were scanned when they were built, and are re-scanned the next time one is
cut.

Every scan is set to **`ignore-unfixed`, CRITICAL and HIGH**. An advisory with no fix available is
not something a version bump can answer, and a check that cannot be made green is a check people
learn to ignore. Unfixed advisories are still visible in the run's output.

## What a release says about itself

Each release carries:

- `perch-<platform>` binaries for macOS, Linux and Windows, and the desktop apps.
- `SHA256SUMS`, and `SHA256SUMS.sig` + `SHA256SUMS.pem` — a **keyless Sigstore signature** made by
  the release workflow's own GitHub OIDC identity. The installer and `perch upgrade` verify the
  checksum always, and the signature wherever `cosign` is on the machine
  (`PERCH_REQUIRE_SIGNATURE=1` / `--require-signature` makes the signature mandatory too).
- `SHA256SUMS.bundle` — the same signature as a Sigstore bundle, which is what newer `cosign`
  produces by default and what `cosign verify-blob --bundle` wants. The detached pair above is kept
  because that is what the installers already on people's machines verify with.
- `sbom-perch-<version>.spdx.json` — an **SPDX SBOM of the source tree the binaries were built
  from**. It is listed in `SHA256SUMS`, so the one signature covers it: a tampered SBOM fails the
  same check a tampered binary does.
- `sbom-api.spdx.json` and `sbom-runner.spdx.json` — an SBOM per image, also attached to the image
  itself as a cosign attestation (`cosign verify-attestation --type spdxjson`).
- The images, signed with cosign keyless at their digest.

Verifying a download by hand:

```sh
# The checksum (this is what the installer always does).
sha256sum -c SHA256SUMS --ignore-missing

# The signature: it must be this repository's release workflow, and nobody else's.
cosign verify-blob \
  --certificate SHA256SUMS.pem --signature SHA256SUMS.sig \
  --certificate-identity-regexp '^https://github\.com/12burb/perch/\.github/workflows/release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS

# …or the same thing from the bundle, which newer cosign prefers.
cosign verify-blob --bundle SHA256SUMS.bundle \
  --certificate-identity-regexp '^https://github\.com/12burb/perch/\.github/workflows/release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

## Findings Perch has accepted, with a date they come back

A scan that cannot be made green is a scan people learn to ignore — and so is one that is quietly
switched off. `.trivyignore.yaml` is the middle: each entry names one CVE, says why it is not
something Perch can fix today, is scoped to the tree it was found in, and **expires**. When the date
passes the scan fails again and somebody looks.

| CVE | Where | Why it is accepted | Returns |
|---|---|---|---|
| CVE-2026-14257, CVE-2026-69152 | `brace-expansion`, inside the agent CLIs | Denial of service in a package Perch does not depend on. The four CLIs are pinned (`deploy/agents.json`, ADR-0152) and each is already at its newest published version; the fix has to come from upstream. | 2026-10-17 |
| CVE-2026-69192 | `ip-address`, inside the agent CLIs | SSRF through inconsistent parsing. Perch's own outbound requests do not go through it — the gateway and the connectors use their own clients — and no credential is reachable from a runner (spec §1.6). | 2026-10-17 |
| CVE-2026-73566 | `tar`, inside the agent CLIs | Denial of service on a crafted archive. Perch never hands a CLI an archive; what one unpacks is what it fetched for itself. | 2026-10-17 |

All four live in `opt/node/lib/node_modules/**` — the tree the runner image installs Codex, Claude
Code, Gemini CLI and OpenCode into. The entries are scoped to that path, so the same CVE appearing
in Perch's own dependencies still fails the scan. And the runner is the sandbox: it runs agent code
by design, one container per workspace, with the limits that container was given (and, since
ADR-0171, with only that workspace's files in it). A denial of service inside one is bounded by what
it was already allowed to spend.

The disclosure drill asserts that every entry here has a reason and a date that has not passed, so
an exception cannot quietly become permanent.

## The disclosure drill

A security policy nobody has walked through is a wish. The drill walks it. Everything that can be
checked without an actual vulnerability is checked by a script:

```sh
bun scripts/disclosure-drill.ts
```

It asserts, in the order a real disclosure would need them:

1. **Report** — `SECURITY.md` offers a private advisory and says not to open an issue; it commits to
   an acknowledgement window and a disclosure window; and this page records who last ran the drill.
2. **Fix** — a dependency advisory fails something without anybody pushing (`security.yml`), every
   image Perch publishes is scanned before it is published (`ci.yml`), and every finding Perch has
   accepted says why and has a date it comes back (`.trivyignore.yaml`).
3. **Release** — the release carries an SBOM per image and one for the binaries; `cosign` signs
   `SHA256SUMS`, and that file covers the SBOM as well as the binaries; and there is a test that a
   tampered download installs nothing — for both `install.sh` and `perch upgrade`.
4. **Tell** — `SECURITY.md` says which versions get fixes, and `docs/install.md` tells an operator
   how to move to the fixed one.

`scripts/disclosure-drill.test.ts` runs the same steps against this repository on every
`bun run check`, so a change that quietly removes the signature, the SBOM, the scans or the tamper
tests fails the gate rather than a future disclosure.

### What the script cannot check

The human half. A real report arrives in a mailbox and somebody has to read it. The drill is run by
a person, who:

1. Files a **test advisory** on a throwaway fork ("drill, not a real report"), confirms it arrives
   privately, and acknowledges it — timing how long that took.
2. Cuts a **pre-release tag** on the fork and watches the release workflow produce the binaries, the
   signature and the SBOMs.
3. Runs the two commands above against those artifacts on a machine that was not the builder, then
   flips one byte in a binary and confirms the installer refuses it.
4. Closes the test advisory and writes the date below.

**Owner:** the maintainer on `SECURITY.md`. **Cadence:** every release, and at least quarterly.

**Last run: 2026-09-17** (the scripted steps; the fork rehearsal is due with the next tagged
release).

## Runners: what is kept apart

Team mode (`PERCH_RUNNER_MODE=docker`) runs one runner container per workspace (ADR-0067), and the
container holds that workspace's files and nobody else's (ADR-0171):

- **Workspaces.** The container mounts `<workspace>/` of the homes volume and `<workspace>/` of the
  projects volume, never the whole of either. A member of one workspace, or an agent working for
  them, has no path to another workspace's projects or homes.
- **Members.** Inside a workspace's container every member runs as a uid of their own and their
  home is theirs alone (mode 700), so one member's shell, agent or dev server cannot read another's
  CLI logins. Projects are shared on purpose: group-writable, one checkout for the whole workspace.
  What the root agent reads or writes for a member, it does with that member's filesystem
  credentials. Git holding a connection token or the deploy key runs as an account nothing else runs
  as, so the member's own agent cannot read the token out of git's environment either.
- **Credentials in git.** A clone or push holding a connection token or the deploy key runs no
  repository hook, asks no credential helper but Perch's, and Perch's answers for the remote's own
  host only; a push whose effective URL leads to another host than the project came from, or whose
  repository config sets its own proxy or CA, is refused before git runs.
- **The runner's token.** The agent is root and nothing it starts is, so no child can read its
  environment. Each container carries a fresh connect token, and minting it revokes every older
  token of that runner, so a token read out of a container that has since been replaced cannot
  register as the runner. A local runner runs everything as its owner and makes itself
  non-dumpable on Linux, which keeps its token out of what it starts; on macOS and Windows a
  process of the owner's could still read it, which is the owner's own machine.

Shared mode (`PERCH_RUNNER_MODE=shared`) is one container for the whole instance with the whole of
both volumes mounted: every workspace's projects and every member's home are in that one container.
Members still run as uids of their own there, so homes stay private, but group 1000 is every
workspace's group: any member of any workspace can read and write every workspace's projects. It is
for a single team that trusts itself, not for workspaces that must not see each other; use docker
mode for those.

What is not kept apart, in either mode: members of one workspace can change each other's project
files and processes' output (that is what a shared checkout is), a dev server one member started
serves everyone, and a file a member made private (mode 600) inside a project is left out of the
nightly project backup, which the supervisor takes as an ordinary user.

## The invariants a report is measured against

Spec §1.6, repeated in `SECURITY.md`, and enforced in code:

- No connection token, API key, or subscription credential reaches an engine, a bot, a model
  context, a log line, or the client — vault in, gateway out (`docs/connections.md`,
  `docs/brains.md`).
- `apps/api` never mounts the Docker socket; only the supervisor does (`docs/runners.md`).
- Runners speak only the §7.6 protocol, and a local runner refuses requests for anybody but its
  owner unless a grant is attached. Nothing a runner starts — a shell, a session, `exec`, a dev
  server, `postCreateCommand`, an MCP server, git — sees the runner's own connect token, master
  key or session secret: not in its own environment (ADR-0160) and not in the runner's, which it
  runs as another uid than (hosted) or cannot read through `/proc` (a non-dumpable local runner on
  Linux) (`docs/runners.md`, ADR-0171).
- On a hosted runner a member's home is readable by that member only (ADR-0171).
- Perch never forwards a caller's bearer token upstream; each connection uses its own delegated
  token.
- Every route names an action `authorize()` knows, and a test proves it (`docs/audit.md`).

A report that shows one of these broken is high severity by definition.
