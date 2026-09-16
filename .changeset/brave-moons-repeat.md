---
"@perch/runner": patch
---

The runner now finds a Chromium that Playwright downloaded, on every platform it downloads one for.
A laptop that has run `playwright install chromium` needs nothing else for preflight or the agent's
eyes, and CI stopped depending on one hard-coded cache path — Playwright's layout is per platform
(`chrome-linux64` on linux-x64, `chrome-linux` on arm64), and the one that exists wins.
