---
"@perch/runner": patch
---

Each person and directory gets a tmux server of its own. On one shared server, tmux started every
new session from the environment of whoever had started the server, so a second person's terminal
had the first one's `HOME`, `PERCH_USER` and project environment. Reattaching still finds the same
session.
