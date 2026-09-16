---
"@perch/api": minor
"@perch/db": minor
"@perch/ui": patch
"@perch/web": minor
---

Background sessions. Start a run with `POST …/sessions/background` and a channel to report in, and
it works to a finish line while nobody watches — then settles, instead of holding a runner open for
a turn nobody is going to type. It keeps **one card** in that channel, rewritten in place rather
than a message per event: what it was asked, where it got to, the tool it is stuck on, and at the
end its turns, tool calls, files changed, cost and how long it took.

Your phone hears only what needs you. `background.notify` in `.perch/project.json` is `needs_you`
by default — a permission it is waiting on, or a failure — and can be `always` or `never`.
