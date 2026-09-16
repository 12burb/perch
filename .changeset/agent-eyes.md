---
"@perch/api": minor
"@perch/events": minor
"@perch/runner": minor
---

The agent's eyes. While a project's preview is actually serving, every session on it is handed a
Playwright MCP server spawned on the runner beside the agent — so it can navigate, snapshot, click
and screenshot the page it is working on, where the page is.

Set `PERCH_PLAYWRIGHT_MCP` to the command that runs it; unset means off. Which build matches the
browser in your runner image is yours to pin, which is why this is a command rather than a version
Perch chose for you. A session with nothing to look at gets no browser.
