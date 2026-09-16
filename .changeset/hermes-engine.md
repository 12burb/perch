---
"@perch/api": minor
"@perch/runner": minor
---

The Hermes engine. A session can run on Hermes Agent (`engine: "hermes"`), the runtime the Nest
agents use. Hermes speaks ACP itself, so Perch runs it through the same client as any other agent:
permissions, modes, diffs, usage and cancellation all behave as they do everywhere else.

What is Hermes' own stays Hermes': it reads its provider setup from the person's own home volume, so
a Nous Portal or Codex subscription signed in with `hermes` in the terminal serves only that
person's sessions and never reaches Perch's vault. The session's brain is passed as
`HERMES_INFERENCE_MODEL`; a session on the engine's own default lets Hermes choose. The runner image
installs it pinned, and a runner without it says which binary is missing.
