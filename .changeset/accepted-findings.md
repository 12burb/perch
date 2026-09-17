---
"@perch/cli": patch
---

Security scanning: the runner image's findings are tracked, not silenced.

The new scan of the runner image found four HIGH advisories, all inside the agent CLIs that image
pins — `brace-expansion`, `ip-address` and `tar`, none of them something Perch depends on, and all
four CLIs already at their newest published version. `.trivyignore.yaml` accepts them one at a
time, each scoped to the tree it was found in, each with a reason, and each with a date it comes
back. `docs/security.md` carries the same list in prose, and the disclosure drill fails if an entry
loses its reason or its date passes.
