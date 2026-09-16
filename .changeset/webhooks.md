---
"@perch/api": minor
"@perch/connect": minor
"@perch/bots": minor
"@perch/db": minor
"@perch/web": minor
---

A provider can tell Perch when something happens. Make an endpoint for GitHub, Vercel or Clerk, paste
its URL and its one-time secret into the provider, and every signed delivery becomes a card in the
channel you wired it to — what happened, who did it, and a link. An unsigned delivery, or one signed
with anything else, is refused and posts nothing; the same delivery twice is one card. Bots can wait
for them too: a `webhook` trigger fires on a delivery and the bot answers in the card's own thread.
