# Spike 0.4.3 — OpenCode SDK

**Pass criterion:** `opencode serve` + the SDK: create session, send prompt, stream events, apply a diff,
list sessions.

**Outcome (ADR-0031): pass for everything that needs no model; the streamed reply is gated on a key.**
`createOpencodeServer` from `@opencode-ai/sdk` 1.18.30 launches the pinned `opencode` 1.18.30 binary (from
the `opencode-ai` npm package) on Bun; `createOpencodeClient` creates a session, lists sessions, reads the
diff, deletes, subscribes to the SSE event stream (`server.connected` arrives), and a prompt against a
provider with no credentials returns instead of hanging. With `OPENAI_API_KEY` (or
`PERCH_SPIKE_OPENCODE_MODEL=provider/model` plus that provider's key) the prompt streams a real reply and
the diff is read after the turn.

The `opencode-ai` package needs its postinstall to place the binary; Bun runs it only for trusted packages,
so the spike runs it explicitly:

```sh
bun run --filter @perch/spike-opencode prepare-binary
bun test spikes/opencode
OPENAI_API_KEY=... bun test spikes/opencode      # credentialed part
```
