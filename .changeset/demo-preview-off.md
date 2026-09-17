---
"@perch/api": patch
"@perch/runner": patch
"@perch/cli": patch
---

The demo workspace no longer starts a dev server behind the setup wizard.

Seeding a project is one thing; leaving a process listening on a port nobody asked about, as part of
finishing a wizard, is another — and on Windows it outlived the instance that started it. The seed
now creates the project and stops there, and the welcome message says which button starts it.
`perch demo`, where somebody did ask to see a preview running, still starts one.

The runner also closes its own copy of the dev server's log handle after handing it to the child: it
had no use for it, and on Windows it was enough to make the project's directory undeletable.
