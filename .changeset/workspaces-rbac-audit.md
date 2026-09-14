---
"@perch/api": patch
"@perch/api-client": patch
"@perch/policy": patch
"@perch/db": patch
"@perch/events": patch
"@perch/bus": patch
---

Workspaces, memberships, RBAC, and the audit log (task 0.9): `authorize(ctx, action, resource)` in
`@perch/policy` (role matrix + token scopes) applied in every workspace handler, with non-members getting
`not_found`; `GET/PATCH /api/workspaces/{ws}`, `GET /api/workspaces/{ws}/members`,
`PATCH/DELETE /api/workspaces/{ws}/members/{user}` (owner rules, last-owner protection, leave);
the `audit_log` table (migration 0003) written by a bus subscriber for every workspace event, with
`GET /api/workspaces/{ws}/audit`; bus envelopes now carry `meta` (request id, client ip).
