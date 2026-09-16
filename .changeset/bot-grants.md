---
"@perch/api": patch
---

A bot may only use the connections it was granted. `tools.call` now checks the grant where the call
happens: a connection nobody granted to this bot is refused, a grant that lists tools refuses
anything outside the list by name, and both refusals are audited. The audit also records that a
**bot** made the call — it used to say a person had, whoever called.
