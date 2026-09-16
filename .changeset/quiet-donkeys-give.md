---
"@perch/api": minor
"@perch/web": minor
---

Traces and cost per task. With `PERCH_OTLP_ENDPOINT` set, every session round, bot run, model call,
tool call and runner RPC is a span on your own collector — ids and small facts only, never a prompt
or a file. Without it, nothing changes and nothing is loaded. A finished work item now says what it
cost and where its time went, on the card and at `GET /api/work-items/{id}/cost`.
