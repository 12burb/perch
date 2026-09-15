# Policy

What may happen here, written down once. A workspace has a policy; a project may have its own, which
narrows the workspace's and never widens it (spec §5.7).

```yaml
version: 1
git:
  protectedBranches: [main, "release/*"]
  allowForcePush: false          # the default: a force push is refused
commands:
  deny:
    - "git push --force"         # a substring
    - "/npm\\s+publish/"          # or a regular expression in slashes
paths:
  allow: ["src/**", "docs/**"]   # absent means anywhere the runner allows
  deny: [".env", "secrets/**"]   # always wins
models:
  allow: ["ollama/*"]            # over provider/model_id, and over profile names
  channels:
    general: { allow: ["ollama/*"] }   # this channel: local models only
  projects:
    api: { deny: ["openai/*"] }
budgets:
  dailyUsd: 20                   # ceilings nothing here may exceed
  perRunUsd: 2
  perThreadUsd: 5
bots:
  toBots: true                   # whether bots may tag each other at all
  maxHops: 6
  channels: [newsroom]           # where they may
```

Anything the document does not mention is allowed: an empty policy refuses nothing, and a document
that will not parse is treated as empty rather than as a locked door.

## Where it is enforced

| Rule | Where it is asked |
|---|---|
| `models.*` | before a bot's turn — the brain it is about to use, in the channel it was asked in |
| `budgets.*` | the bot's own budget, capped to the lower of the two |
| `bots.*` | a bot tagging another: whether it may here, and how far a chain may go |
| `git.protectedBranches` | `POST .../git/push`, before the runner is asked |
| `commands.deny`, `paths.*` | the dry run, and the runner's own floor underneath it |

A runner enforces a floor of its own whatever the document says — destructive commands, package
publishes, force pushes, git internals, exec confined to the projects root — so a policy can tighten
what an agent may do and never loosen it (ADR-0070).

A refusal is a `451` with the rule in its details, and a `policy.violation` on the bus, which is what
puts it in the audit log. A bot refused in a channel says so in the channel, in the thread it was
asked in, rather than answering.

## Reading and writing it

```
GET  /api/workspaces/{ws}/policy                     → { yaml, rules, effective }
PUT  /api/workspaces/{ws}/policy                     { yaml }         (admin)
GET  /api/workspaces/{ws}/projects/{p}/policy        → { yaml, rules, effective }
PUT  /api/workspaces/{ws}/projects/{p}/policy        { yaml }
POST /api/workspaces/{ws}/policy/evaluate            { request, project_id? } → { allow, rule, reason }
```

`effective` is the workspace's rules with the project's narrowing already applied.

The dry run is the same evaluator every enforcement point asks, so what it says is what would
happen. Settings → Policy has it beside the document: pick what somebody might do, type it, and see
which rule decides.

## How two documents merge

The workspace's document is the base; the project's narrows it.

- Lists join: both layers' protected branches are protected, both layers' denied commands are denied.
- Allow-lists shrink: a project can allow fewer models, never more.
- Ceilings take the lower number.
- `bots.toBots` stays off once either layer turns it off; `git.allowForcePush` cannot be turned on by
  a project the workspace did not turn it on for.
