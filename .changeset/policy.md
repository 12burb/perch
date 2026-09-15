---
"@perch/policy": minor
"@perch/api": minor
"@perch/web": minor
"@perch/db": minor
"@perch/ui": minor
---

The policy engine: one written document says what may happen in a workspace, and a project can
narrow it. Protected branches, refused commands, paths an agent may write, which models a channel or
a project may use, ceilings on what may be spent, and how far bots may go tagging each other. A
channel pinned to local models turns a cloud-brained bot away in the thread it was asked in, a push
to a protected branch is refused before the runner is asked, and Settings → Policy has a dry run
beside the document: type what somebody might do and see which rule decides.
