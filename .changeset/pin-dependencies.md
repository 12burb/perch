---
"@perch/api": patch
"@perch/web": patch
"@perch/runner": patch
"@perch/ui": patch
"@perch/db": patch
"@perch/gateway": patch
"@perch/engines": patch
"@perch/connect": patch
"@perch/bots": patch
"@perch/api-client": patch
---

Resolve and pin every dependency named in the spec (docs/dependencies.md), with ADR-0019..0028 for the non-obvious picks; commit the lockfile.
