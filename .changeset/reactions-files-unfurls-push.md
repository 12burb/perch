---
"@perch/api": minor
"@perch/web": minor
"@perch/db": minor
"@perch/policy": minor
"@perch/ui": minor
---

Chat carries more than words. React to a message with an emoji and see who else did; attach a file
and have an image show itself in the flow; paste a Perch identifier — `project:NEST`,
`channel:general`, `session:8f2c` — and get a card for what it points at, but only ever for things
you could have opened yourself. And when somebody mentions you while you are not looking, your
phone says so: Perch registers a service worker, encrypts each notification to that device (RFC
8291) and identifies itself to the push service with VAPID, so the service carries ciphertext and
learns nothing about who it is for. Every upload downloads as an attachment and only real image
types preview, so nothing anybody uploads can run on Perch's origin.
