---
"@perch/api": minor
"@perch/web": minor
"@perch/runner": minor
"@perch/engines": minor
"@perch/events": minor
"@perch/db": minor
"@perch/ui": minor
---

Quick actions, a thinking level, and a background policy — all of them the project's own
`.perch/project.json` deciding how Perch behaves.

A project's `run` commands and its new `actions` become buttons above the composer and commands in
⌘K. A prompt action sends its text as a turn in its own mode and thinking level; a run action is
typed into the project's terminal, where its output belongs. Firing one from ⌘K with no session open
starts one.

The composer's **Thinking** control sets a session's reasoning level (auto, low, medium, high) and
sends it with every turn. The ACP adapter maps it onto the agent's own session config — ACP's
`thought_level` option where an agent offers one — rather than asking the model nicely in prose.

`background.unattended` names the tools that may run with nobody watching: Perch answers those
permission prompts itself and says so in the transcript, while everything else still waits for a
person. `background.autoSettle` ends a session once a round finishes with nothing outstanding, so a
background run does not hold a runner open. Neither weakens the policy engine.

And `.perch/project.json` can finally be re-read where the project is —
`POST .../projects/{p}/config/reload` — instead of only at setup, which re-clones.
