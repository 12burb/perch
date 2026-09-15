---
"@perch/api": minor
"@perch/web": minor
"@perch/db": minor
---

Search. One box finds what was said and what was attached — Postgres full text over messages, names
over files — with filters for the kind, the channel and the person, and the words you searched for
marked in each result. A result opens as a peek with "Open full" to the channel it was said in, so
following one does not lose the list. Everything is scoped to what you could already read: a private
channel keeps its messages out of everybody else's results, and its attachments with them — reading
a file now means seeing a message that points at it, which is the last of what ADR-0093 left open.
A search of 100,000 messages answers in about 50 ms.
