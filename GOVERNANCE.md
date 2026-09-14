# Governance

## Now: BDFL

Perch is maintained by its founder, [@12burb](https://github.com/12burb), who has the final say on
direction, scope, and releases. The specification (`docs/spec/PERCH-SPEC.md`), the queue (`TASKS.md`), and
the decision log (`DECISIONS.md`) are the public record of that direction; nothing ships that isn't traceable
to them.

## Maintainers

Maintainers are added by contribution record: sustained, reviewed contributions in an area (a package, a
connector family, docs, releases) over a few months, plus a nomination by an existing maintainer and no
objection from the BDFL. Maintainers own review and merge in their area (see `.github/CODEOWNERS`), triage
issues, and can cut releases. Maintainers who go quiet for six months move to emeritus and can come back
any time.

Agents (the Nest agents, Claude Code, and others) may run first-pass triage, review, and test-writing.
Merge is a human act.

## Decisions

- Small decisions: an ADR in `DECISIONS.md` in the PR that makes them.
- Big decisions go through an RFC in `docs/rfcs/` before code. An RFC is required for: licensing, the
  runner protocol (spec §7.6), the Bot API (§7.3), the policy schema (§5.7), and `PLEDGE.md`. An RFC is a PR
  adding `docs/rfcs/NNNN-title.md` from the template; it stays open for at least two weeks of discussion;
  the BDFL accepts, rejects, or asks for changes; the outcome is recorded in `DECISIONS.md`.
- The seventeen decisions locked by the spec (ADR-0001 to ADR-0017) change only through an RFC.

## Releases

Semver. `main` is protected and requires green CI. Changesets produce the changelog. Tagged releases publish
multi-arch images to GHCR (cosign-signed, SBOM attached), `perch` binaries per platform, and the npm
package. A nightly tag tracks `main`.

## Conduct and security

`CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) applies to every project space. Security reports follow
`SECURITY.md`.

## Money

GitHub Sponsors and Open Collective fund the project. Any paid convenience layer (a hosted Perch, a hosted
OAuth broker) is bound by `PLEDGE.md`: the self-hosted core stays complete.
