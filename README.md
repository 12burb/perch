# Perch

**Your code. Your crew. Your bots. Your models. Self-hosted.**

Perch is a self-hosted agentic workspace in one TypeScript monorepo on Bun: an OpenCode-simple IDE, a
Slack-shaped team chat where bots are members, a bot forge, connections to GitHub, Vercel, Supabase, Clerk
and any MCP or OAuth service, a preview browser with a click-to-source inspector, Plane-shaped work tracking,
an approval inbox, and a model gateway for any API key, local model, or vendor-permitted subscription.

The spec lives in [`docs/spec/PERCH-SPEC.md`](docs/spec/PERCH-SPEC.md). The build queue is
[`TASKS.md`](TASKS.md). Decisions are in [`DECISIONS.md`](DECISIONS.md).

Phase 0 (foundation) is under construction; the 60-second install lands with task 0.2 and the compose
story with task 0.13.

## Development

```sh
bun install --frozen-lockfile
bun run check      # Biome + typecheck + bun test
```

## License

AGPL-3.0-only for `apps/*` and every package not listed here; MIT for `packages/bot-sdk`, `packages/ui`,
`packages/events`, `packages/api-client`, `connectors/`, and `templates/`. See [`LICENSE`](LICENSE) and the
`LICENSE` file inside each MIT package.
