---
"@perch/ui": minor
"@perch/web": minor
"@perch/api": minor
"@perch/api-client": minor
"@perch/runner": minor
"@perch/events": minor
---

Review what an agent changed: a Changes view in the session pane shows the diff of one turn or of
the whole session, with labelled hunks you accept or reject one at a time, Accept all / Reject all
per file, and Open to jump to the file. Rejecting a hunk takes just those lines back out. Every
turn now takes a checkpoint of the project first, so any turn can be restored from the transcript,
and a code block in a reply can be applied to the file its fence names.
