# Spike 0.4.2 — ACP handshake

**Pass criterion:** the ACP SDK client initializes Gemini CLI and Codex, streams a session, and answers a
permission request.

**Outcome (ADR-0030): pass for the SDK on Bun; real agents gated on vendor credentials.**
`@agentclientprotocol/sdk` 1.4.0 runs on Bun on both sides of the wire: `agent.ts` is a stub registry-style
agent (streams text, reports tool calls, asks permission, honours cancel) spawned over stdio; `client.ts`
drives it with the fluent client API (`initialize` → `buildSession` → `prompt` → `nextUpdate` loop →
`requestPermission` answered → `end_turn`). Both `allow` and `deny` answers reach the agent.

```sh
bun test spikes/acp
# a real registry agent (needs its vendor key):
PERCH_SPIKE_ACP_AGENT="gemini --experimental-acp" GEMINI_API_KEY=... bun test spikes/acp
PERCH_SPIKE_ACP_AGENT="npx -y @zed-industries/codex-acp" OPENAI_API_KEY=... bun test spikes/acp
```

Task 1.9's acceptance (Gemini CLI and Codex complete a two-turn session with one permission prompt) runs the
real-agent test in CI with secrets.
