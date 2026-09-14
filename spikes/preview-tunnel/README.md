# Spike 0.4.9 — preview tunnel over a local runner

**Pass criterion:** the HMR WebSocket for a Vite app on a local runner works end to end through the api.

**Outcome (ADR-0037): pass.** `api.ts` is a Bun.serve prototype of spec §7.6 `http.open`: a runner opens
one outbound control WebSocket (`/api/runner`, JSON-RPC 2.0); a browser request to `/p/<port>/<path>` makes
the api mint a stream token and ask the runner to open it; the runner connects a data socket to
`/api/runner/stream/<token>` and serves the request from `127.0.0.1:<port>`. HTTP requests travel as head +
body frames; WebSocket upgrades are relayed frame by frame with the subprotocol preserved. `runner.ts` is
the runner half. The dev server is a real Vite 8 dev server bound to localhost (`vite-server.mjs`, run under
Node because it stands in for the user's project process; Vite itself does not load under Bun's isolated
store, which is irrelevant to Perch code).

The test plays the browser: `index.html` and a transformed module arrive over HTTP; the `vite-hmr` socket
handshakes (`connected`) and delivers an `update`/`full-reload` after a file edit on the runner's disk.
Vite does not answer a JSON ping, so client→server WebSocket traffic is covered by the stand-in used during
development, not by the Vite test.

```sh
bun test spikes/preview-tunnel
PERCH_TUNNEL_DEBUG=1 bun test spikes/preview-tunnel   # trace every relay step
```

Task 1.19 builds the real implementation on the runner protocol; this prototype fixes the mechanism.
