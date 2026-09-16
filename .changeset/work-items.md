---
"@perch/db": minor
"@perch/api": minor
"@perch/web": minor
"@perch/ui": minor
"@perch/bots": minor
"@perch/bot-sdk": minor
"@perch/policy": minor
---

Work items and the board. Work mode is no longer an empty state: a project has a board with one
column per state, cards carrying `KEY-123`, and the two columns no other tracker has — **Running**
and **Needs you**.

Nobody drags a card into either. **Hand to an agent** opens a coding session on the item's project,
and from then on the item follows it: running while the agent works, needs-you when it stops to
ask, and in review when it finishes — never straight to done, because an agent finishing is not a
person agreeing. A session opened from a card lets go of its runner when it is done, which is what
moves the card.

An item can start as a message in a channel and keep the thread it came from, so the work and the
talking stay one thing. Bots hear `work_item.updated` over the Bot API with the identifier and
what moved. And `work.create` and `work.update` complete Perch's own MCP server at `/mcp/perch`,
so an agent outside can put something on the board and move it, naming items the way a person
would: `NEST-12`.

The board is live, works at 390 px, and asks for at most 200 items at a time — past that the
useful answer is a filter rather than more cards.
