---
"@perch/connect": minor
"@perch/connectors": minor
"@perch/events": minor
"@perch/db": minor
"@perch/api": minor
"@perch/web": minor
"@perch/ui": minor
---

Ship from the IDE, and look at your database while you are there. The drawer has two new tabs.
**Deploy** builds the project's branch through a Vercel connection and posts a card in the channel
you choose; the card is the deploy's record, rewritten in place as the build moves, so the preview
URL appears in the message that announced it rather than in a second one underneath.

**Database** lists the tables and columns of a connection's database and runs one statement. It goes
through Perch's MCP gateway on the connection's own token, so nothing new touches a credential, and
it is read-only: a statement that writes is refused before the provider is asked, with the rule that
said so. Which tools a provider's database is browsed with comes from its connector manifest.
