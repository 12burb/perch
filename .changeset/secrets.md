---
"@perch/policy": minor
"@perch/api": minor
"@perch/web": minor
"@perch/ui": minor
---

Secret scanning before every commit. What a commit is about to take — including the files an agent
has just written, which git has never seen — is read for the shapes providers stamp on their tokens,
private keys, passwords in connection strings, and names that say secret beside a long value. A
finding stops the commit and the Git panel shows a card saying what it is and which line it is on,
with the value masked. Nothing is committed, so taking it out and committing again is all it takes.
Placeholders, example files and lines being removed are left alone, and a repository can name its
own exceptions in its policy.
