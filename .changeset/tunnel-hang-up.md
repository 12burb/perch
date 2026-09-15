---
"@perch/runner": patch
"@perch/api": patch
---

Previews through a laptop's tunnel come back whole. The runner used to hang up on a stream as soon
as it had sent the answer, and a client socket throws away whatever it has not written yet — so a
large page could arrive with its tail missing and nothing to say so. The runner now leaves the
hang-up to the api, which closes once it has everything, and a stream that dies mid-answer fails the
request instead of quietly truncating it.
