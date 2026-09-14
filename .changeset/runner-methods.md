---
"@perch/runner": minor
"@perch/api": minor
"@perch/events": minor
"@perch/api-client": minor
"@perch/cli": patch
---

Runners answer the fs (list, read, write, stat, ripgrep-backed search), git (status, diff, commit,
push, branch, worktrees), ports, and exec methods, every call through a policy hook with built-in
rules (destructive commands, publishes, force pushes, git internals, exec confined to the projects
root); the Environments list shows each runner's listening ports and the api answers them live.
