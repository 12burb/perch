---
"@perch/runner": patch
"@perch/engines": patch
"@perch/api": patch
"@perch/bot-sdk": patch
"@perch/events": patch
"@perch/ui": patch
"@perch/web": patch
---

Dependencies are declared where they are used and nowhere else: the runner no longer ships
`@playwright/mcp` (the command in `PERCH_PLAYWRIGHT_MCP` is the operator's), `@perch/engines` drops
three packages it never imported, the api and the repository scripts declare the test doubles and
parsers they import, and `packages/ui` pins its peers exactly like everything else (the repository
invariant now checks peers). The lockfile is refreshed to the current workspace versions. Renovate
sees every pin: the agent CLIs in `deploy/agents.json` and the runner image's Bun, Playwright and
Hermes build arguments have regex managers, with OpenCode's SDK and binary, and Playwright's runner
and browser build, grouped so each pair moves together. The web app's tests are typechecked with the
app. On the wire: `/mcp/{id}` answers 404 for an id of a shape no connection or server has, rather
than a database error; the api parses the runner's `git.push`, `git.branch`, `fs.list` and `fs.read`
answers with their schemas instead of casting them; a preview tunnel's head frame is checked field by
field before a Response is built from it; and the bot SDK turns an answer that is not JSON into a
`PerchBotError` carrying the status and the code `bad_response` instead of throwing from its parser.
