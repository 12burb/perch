---
"@perch/api": minor
"@perch/web": minor
"@perch/ui": minor
"@perch/bots": minor
"@perch/db": minor
---

Interactive blocks. A message can now ask a question — a button, a select, a form, approve or deny,
and a progress bar that reports without asking anything — and answering it writes the answer into
the block itself: the message says what was decided, by whom and when, so everybody sees the same
outcome and it is still there tomorrow. Answering is not editing, so nothing gains an "(edited)"
mark, and a question is answered once. The payload goes to whoever owns the block over the Bot API
(`interaction.received`), which is the seam the bot runtime and webhooks will subscribe to.
