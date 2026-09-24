---
"@perch/runner": patch
---

The runner image takes Bun and uv from their makers' own images and checks Node's signed checksums
against Node's release keys, so every third-party binary in it is verified by signature, not only by
a checksum published beside it.
