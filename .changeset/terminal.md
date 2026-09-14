---
"@perch/web": minor
"@perch/ui": minor
"@perch/api": minor
"@perch/runner": minor
"@perch/events": minor
---

The terminal: Code mode's drawer opens a shell on the project's runner (xterm.js), per person,
inside tmux where the machine has it; a reload or a reopened drawer comes back to the same shell
with its scrollback, and file paths printed in the output open in the editor. Runners answer
`pty.open/input/resize/close` and carry terminal data over `/api/runner/stream/{token}` sockets.
