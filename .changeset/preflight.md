---
"@perch/api": minor
"@perch/db": minor
"@perch/events": minor
"@perch/runner": minor
"@perch/ui": patch
"@perch/web": minor
---

Preflight before push. Set `preview.preflight` in `.perch/project.json` and a push runs the
project's own lint, test and build, then opens each of its configured routes in the runner's browser
and looks at them. A console error or a request that did not come back is a failure — the half a
test suite cannot do, because a page that throws on load passes every unit test ever written.

`block` refuses the push with the checklist; `warn` pushes and shows it anyway; absent is off. Run it
on its own with `POST …/preflight`, and with a channel it posts the checklist card: a row per check,
the reason for each failure, and the picture taken of each route.

The runner now drives its browser over the DevTools protocol rather than `--screenshot`, because
that is the only way to know which console lines the page thought were errors. Screenshots are
unchanged; they just come back knowing more.
