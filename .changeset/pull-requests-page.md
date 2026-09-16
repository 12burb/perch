---
"@perch/api": minor
"@perch/ui": patch
"@perch/web": minor
---

The Pull Requests page. Code mode's drawer has a **Pull requests** tab: the connection's open pull
requests, and any one of them with its inline comments — each on the file and line it was left on —
the reviews so far, and what the checks made of the head commit. Approve, request changes, or
comment, straight back to the provider.

And **Ask the agent to address it**: a session opens on the pull request's own branch and its first
turn is the review itself, every comment with its file and line. It is told to change the code and
not to reply in the pull request, because the push is what answers a review.
