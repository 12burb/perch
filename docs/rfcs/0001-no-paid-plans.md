# RFC-0001: No paid plans; every model is the user's own

- Status: open
- Author(s): the maintainers
- Opened: 2026-09-14
- Decided: (pending; the code and docs already follow ADR-0064)

## Summary

Add to `PLEDGE.md` the commitment that Perch has no paid plans, tiers, seats, metering, or license keys,
that nothing is gated behind one, and that every model runs on credentials the user brings. The maintainer
set this direction on 2026-09-14 ("we will not include any paid plans for this, it's open source, but
anyone can connect their own models to the platform"); ADR-0064 records it for the code, and the README
states it. The pledge is the place users look for exactly this promise, and the pledge changes only through
an RFC (`GOVERNANCE.md`), hence this document.

## Motivation

Pledge item 4 already forbids removing features from self-hosted to sell them hosted, seat limits, and
crippleware. It does not say that Perch itself will never carry a paid plan. Projects that started free and
later added tiers taught their communities to read that gap carefully; closing it in the pledge makes the
promise as durable as the licensing one.

## Design

Amend pledge item 4 to read:

> **No paid plans.** Perch has no paid plans, tiers, seats, metering, or license keys, and nothing is gated
> behind one. Every model runs on credentials you bring: your own API keys or OpenAI-compatible endpoints,
> or your own vendor subscriptions where the vendor permits it. A hosted Perch or a hosted OAuth broker may
> exist as a convenience; the self-hosted core stays complete.

No code changes: `workspaces.plan` remains a deployment descriptor (`self-hosted`) and no policy check
reads it (ADR-0064).

## Alternatives

Leaving the promise in the README and ADR-0064 only. Rejected: the pledge is signed and RFC-guarded; the
README is not.

## Impact

Security invariants: none. Pledge: strengthened. Licensing: unchanged (ADR-0007). ACP, MCP, AGENTS.md,
Agent Skills, devcontainer.json, OpenAPI: unaffected.

## Rollout

On acceptance: update `PLEDGE.md` item 4 as above, set this RFC to `accepted` with the date, and note the
acceptance in ADR-0064. No feature flag, no migration.
