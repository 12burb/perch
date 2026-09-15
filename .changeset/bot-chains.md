---
"@perch/api": minor
"@perch/web": minor
"@perch/ui": minor
"@perch/bots": minor
"@perch/db": minor
---

Bots can work together. One bot tags another in a thread — to ask, to fan a question out to several,
or to hand the task over — and the answers land in the same thread, attributed. What keeps that from
running away is on rails: six hops per conversation, no bot answering itself, a pair that keeps
bouncing stopped on the third leg, and a budget for the whole thread that the bot which started it
sets. When the rails stop a chain the thread pauses and a card asks a person whether to carry on, and
anybody can type `/stop` or `/resume` themselves. The thread's header says who is in it, how far it
went, and what it cost.
