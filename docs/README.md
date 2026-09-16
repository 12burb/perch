# Perch docs

| Page | What |
|---|---|
| [`spec/PERCH-SPEC.md`](spec/PERCH-SPEC.md) | The binding specification and operating manual |
| [`spec/PERCH-PLAN.md`](spec/PERCH-PLAN.md) | The extended build plan (v2.0) behind the spec |
| [`spec/KICKOFF.md`](spec/KICKOFF.md) | Kickoff prompts for agent sessions |
| [`dependencies.md`](dependencies.md) | Resolved and pinned package versions (task 0.3) |
| [`install.md`](install.md) | Installing Perch: the one-liners, what is checked before anything is written, package managers, `perch upgrade` |
| [`deploy.md`](deploy.md) | Team mode with docker compose: `perch init`, the images, the setup wizard |
| [`ci.md`](ci.md) | The pull-request pipeline, the release workflow, the perf budgets |
| [`backups.md`](backups.md) | Backups: what one is, the schedule, the vault key, restoring into an empty instance, and the drill CI runs |
| [`runners.md`](runners.md) | The runner control channel, hosted and local runners, the supervisor |
| [`desktop.md`](desktop.md) | The desktop app: laptop mode in a native window |
| [`projects.md`](projects.md) | Projects: empty, upload, clone with a token or the deploy key; project.json and devcontainer.json |
| [`editor.md`](editor.md) | Code mode's file tree and editor: CodeMirror 6, tabs, breadcrumbs, search, markdown and image preview |
| [`terminal.md`](terminal.md) | The terminal drawer: shells on the project's runner, tmux persistence, reattach after a reload, path links |
| [`sessions.md`](sessions.md) | Agent sessions: the Engine interface, the lifecycle, transcript persistence and replay, live updates |
| [`connections.md`](connections.md) | Connections: the lanes, the GitHub App wizard, the CIMD document, cloning and opening PRs on one |
| [`brains.md`](brains.md) | Brains: provider credentials, model profiles, the live catalog, Ollama auto-detect |
| [`mcp-gateway.md`](mcp-gateway.md) | The MCP gateway: a connection's tools for an agent, without the credential |
| [`previews.md`](previews.md) | Previews: the two URL shapes, HMR, who gets in, and share links |
| [`inspector.md`](inspector.md) | The inspector: the dev plugins, the injected client, context chips, screenshots |
| [`chat.md`](chat.md) | Chat: channels, who can see them, joining and leaving, archiving, unread |
| [`bot-api.md`](bot-api.md) | The Bot API: a token, the Slack-shaped endpoints, socket mode, and `perch-bot-sdk` |
| [`git.md`](git.md) | The Git panel: what changed, a written message, branch, push, open a PR |
| [`inbox.md`](inbox.md) | The inbox: what needs you, where it comes from, and approving from a phone |
| [`policy.md`](policy.md) | The policy: what may happen here, how two documents merge, and where each rule is asked |
| [`shipping.md`](shipping.md) | The Deploy button and the database panel: preview-URL cards in a thread, read-only SQL |
| [`repo-intelligence.md`](repo-intelligence.md) | The codebase index: `@codebase`, semantic search, optional embeddings, the AGENTS.md draft |
| [`project-env.md`](project-env.md) | A project's environment: write-only values, where they are injected, and why a transcript never repeats them |
| [`phase-0-report.md`](phase-0-report.md) | What Phase 0 delivered: commits, verification, spike outcomes, ADRs, deviations |
| [`telemetry.md`](telemetry.md) | Every field the opt-in ping sends |
| [`policies/providers.md`](policies/providers.md) | The credential matrix and the three lanes |
| [`rfcs/`](rfcs/) | RFCs for licensing, runner protocol, Bot API, policy schema, the pledge |
| [`../DECISIONS.md`](../DECISIONS.md) | Architecture decision records |
| [`../TASKS.md`](../TASKS.md) | The build queue |

The docs site (Astro Starlight) arrives in Phase 4; until then these Markdown files are the docs.
