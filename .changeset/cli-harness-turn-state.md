---
"@perch/runner": patch
---

Fixes two engine adapter bugs found by CI: a cli-harness turn could not be cancelled when the
previous CLI process exited after the next turn had started (its late exit cleared the new turn's
state), and file paths reported by a CLI or agent through a symlinked project directory (macOS
`/private/var` for a `/var` project) came back as `../../…` instead of project-relative. Turn state
now lives on the turn itself, and reported paths are taken through the real ancestors of both
sides, including files that do not exist yet.
