---
"@perch/api": patch
---

An api token bound to a workspace is bound to a membership: it cannot be made for a workspace its
owner is not in, it stops working on the MCP routes when they leave, and on REST it is narrowed to
that workspace (ADR-0162). The brain credential a session runs on is redacted from its transcript
the same way a project's secrets are, so an agent asked to print its environment cannot put the
key into a model context or a client.
