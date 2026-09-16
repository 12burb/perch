---
"perch": patch
---

`bun run check` now parses every GitHub workflow. A workflow with a syntax error does not fail
loudly — GitHub runs it anyway, names the run after the file instead of the workflow, and fails it —
so the first sign of one is a red `main`.
