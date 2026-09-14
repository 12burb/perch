---
"@perch/engines": minor
"@perch/api": minor
"@perch/api-client": minor
"@perch/events": minor
"@perch/db": minor
"@perch/policy": minor
---

Sessions: the Engine interface with a fake engine and a runner-hosted bridge, the
coding_sessions/session_events tables, and api routes to open a session in a project, send turns,
answer permissions, cancel, and replay the transcript from a seq; every event fans out live on the
session's WS topic.
