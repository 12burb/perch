---
"@perch/web": patch
"@perch/ui": patch
---

Accessibility: every screen is audited by axe at 390 px and 1440 px, and every flow can be driven by
keyboard alone. Three things that were broken are fixed — the mode rail could not be moved through
without a mouse (the arrow keys existed only on a rail that was not the one the app renders), the
command palette left focus on nothing when it closed, and the Work board's columns scrolled without
being reachable by keyboard. New docs: `docs/accessibility.md`.
