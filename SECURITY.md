# Security policy

Perch runs code from agents, holds API keys and OAuth tokens, and proxies dev servers. Security reports are
taken seriously and handled privately.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
<https://github.com/12burb/perch/security/advisories/new>. Do not open a public issue.

Include what you can: affected version or commit, deployment mode (compose, laptop binary, from source), steps
to reproduce, and impact. Redact any real tokens or keys.

## What to expect

- **Acknowledgement within 3 days** of the report.
- A maintainer works with you on severity, a fix, and a coordinated release.
- **Coordinated disclosure after 90 days** at the latest, or earlier once a fix ships. We credit reporters
  in the advisory unless they prefer otherwise.
- There is no bug bounty yet; one will be announced when there is money to fund it.

## Scope

In scope: `apps/*`, `packages/*`, `deploy/*`, the published images and binaries, and the documented
self-hosting setups. The threat model (multi-user on a shared host, prompt injection, token exfiltration,
confused deputy) is described in `docs/spec/PERCH-PLAN.md` §7 and enforced by the invariants in spec §1.6:

- No connection token, API key, or subscription credential ever reaches an engine, a bot, a model context, a
  log line, or the client.
- `apps/api` never mounts the Docker socket; only the supervisor does.
- Runners speak only the runner protocol; a local runner refuses requests for users other than its owner
  unless a grant is attached.
- Perch never forwards a caller's bearer token upstream; each connection uses its own delegated token.

Reports that show a violation of any invariant above are treated as high severity.

## What Perch does about it

What gets scanned and when, what a release carries (signatures, SBOMs), how to verify a download by
hand, and the disclosure drill this policy is rehearsed with: [`docs/security.md`](docs/security.md).
The scripted half of the drill runs on every `bun run check`, so the reporting path, the signature,
the SBOMs and the tamper tests cannot quietly disappear.

## Supported versions

Until 1.0, only the latest release and `main` receive fixes.

## Practices

Renovate for dependencies; CodeQL, Trivy, and secret scanning in CI; no secrets in images; signed releases
(cosign) with SBOMs; migrations run under an advisory lock; envelope encryption for every stored secret.
