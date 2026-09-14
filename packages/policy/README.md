# @perch/policy

`authorize(ctx, action, resource)` (spec §9.1) and, from task 2.11, the `policy.yaml` parser and
evaluator (spec §5.7). Pure functions: no database, no HTTP.

```ts
import { authorize } from "@perch/policy";

const decision = authorize(
  { userId, role: "admin", scopes: ["read"] }, // role: the caller's membership; scopes: only for api tokens
  "workspace.update",
  { type: "workspace", id: workspaceId },
);
// { allowed: false, reason: "scope", message: "this token lacks the admin scope" }
```

The role matrix and per-action token scopes are in `ROLE_MATRIX` and `SCOPE_FOR_ACTION` (ADR-0051).
Denials carry a `reason`: `not_member` (the api answers not_found), `role`, `scope`, `self`.
