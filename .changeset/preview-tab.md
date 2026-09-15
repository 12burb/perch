---
"@perch/api": minor
"@perch/cli": minor
"@perch/preview": minor
"@perch/ui": minor
"@perch/web": minor
---

Watch a project run. Every port a project's runner is serving now appears in Code mode's Previews
sidebar and opens in a Preview tab beside the editor (⌘⇧P): an address bar, back and forward,
reload, viewport presets with rotate, and a link out to a real tab. HMR passes straight through, so
a Vite app hot-reloads inside the tab with no configuration when the instance has a preview domain.
Share mints an expiring, revocable link that opens the preview for someone with no Perch account,
and shows the dev server's own page — never an injected inspector.
