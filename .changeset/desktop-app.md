---
"@perch/desktop": patch
"@perch/cli": patch
---

The Perch desktop app: `perch-desktop` runs laptop mode (api, web, and the in-process runner on PGlite
under `~/.perch`) in a native window on macOS, Windows, and Linux, on a fixed localhost port so sign-ins
survive restarts, attaches to a Perch already running there, and opens a team instance with `--url`.
`perch dev` now shares its boot with the app (`@perch/cli/laptop`).
