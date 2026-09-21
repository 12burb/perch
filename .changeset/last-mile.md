---
"@perch/api": patch
"@perch/runner": patch
---

The runner image downloads Bun and uv from their GitHub releases and verifies each against the
release's published checksums instead of piping an install script into a shell. The background
service's memory of what it woke a phone about is bounded to ten thousand sessions. `bun run test`
runs each workspace's tests in its own process, and `bun run gate` runs the whole local gate in
CI's order.
