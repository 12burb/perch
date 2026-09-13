# @perch/events (MIT)

The Zod contracts every part of Perch shares:

- `bus-events.ts` — the spec §7.7 catalog: `busEventPayloads` (one schema per event name), `BusEvent`
  envelope, `parseBusPayload`. A test asserts the catalog matches the spec's list exactly.
- `ws.ts` — spec §7.2: client ops (`subscribe`, `unsubscribe`, `ping`, `typing`, `presence`, `resume`)
  and the server envelope `{ type, topic, seq, ts, payload }`; `WS_REPLAY_BUFFER = 1000`.
- `runner-rpc.ts` — spec §7.6: JSON-RPC 2.0 envelopes and a params schema per method in both directions;
  every api → runner request carries `workspace_id`, `user_id`, and a capability token.
- `engine.ts` — spec §3.3 `EngineEvent`, `FileDiff`, permission answers, session modes, engine ids.
- `errors.ts` — spec §7.8 error codes, statuses, and the wire shape.
