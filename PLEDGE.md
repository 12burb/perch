# The Perch pledge

Communities have been burned by license changes at projects they built on. Perch makes these commitments in
the repository, where a change would be a public act and would need an RFC (`GOVERNANCE.md`).

1. **The core stays under OSI-approved licenses.** `apps/*` is AGPL-3.0; the SDK-facing packages, connector
   manifests, and templates are MIT. No source-available switch, no "business" license, no delayed open
   sourcing.
2. **No branding clause.** You may run, fork, and rebrand Perch. The Perch name and logo are trademarks
   reserved for official builds, and that is the only restriction.
3. **No CLA that enables relicensing.** Contributions are accepted under the DCO only. Relicensing would
   need every contributor's consent, which is the point.
4. **No feature removed from self-hosted to sell it hosted.** A hosted Perch or a hosted OAuth broker may
   exist as a convenience; the self-hosted core stays complete, with no seat limits and no crippleware.
5. **Telemetry is opt-in.** Off by default; when on, it sends only the fields listed in
   `docs/telemetry.md`, never content, prompts, or tokens.
6. **Your keys and tokens never leave your instance.** API keys, OAuth tokens, and subscription credentials
   are encrypted at rest and reach connected services only through your own instance's gateway, under a
   grant, with audit. Perch never phones home with them and never proxies subscriptions a vendor forbids.

Signed by the maintainers on 2026-09-12. Changes to this file require an RFC and are recorded in
`DECISIONS.md`.
