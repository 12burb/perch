# Spike 0.4.5 — QuickJS sandbox

**Pass criterion:** a code bot runs with a 200 ms CPU budget, no host access, and a tool call round trip.

**Outcome (ADR-0033): pass.** `quickjs-emscripten` 0.32.0 (the sync release build via `getQuickJS()`) on
Bun: an infinite loop is interrupted by `shouldInterruptAfterDeadline` inside the 200 ms budget; the bot
sees no `fetch`, `process`, `require`, `Bun`, `Deno`, or `XMLHttpRequest`; host tools are exposed as a
function that returns a QuickJS promise (`ctx.newPromise()`) settled from the host with
`runtime.executePendingJobs()` driving the continuation, so `await tool("chat_post", …)` round-trips and a
failing tool rejects inside the bot; a 4 MB memory limit throws `out of memory`.

The asyncify build (`newQuickJSAsyncWASMModule`) was tried first and is not used: on Bun 1.3.11 runtime
disposal fails with `QuickJSRuntime not found when trying to free HostRef`. The promise pattern needs no
asyncify.

```sh
bun test spikes/quickjs
```
