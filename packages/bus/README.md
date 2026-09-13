# @perch/bus

Typed in-process pub/sub over the `@perch/events` catalog (spec §3.1: no Redis by default; the Redis
adapter is a Phase 5 implementation of the same `Bus` interface).

```ts
const bus = createBus();
bus.subscribe("message.created", async (e) => { /* fan out, index, notify */ });
bus.subscribeTopic("channel:c1", (e, seq) => ws.send(envelope(e, seq)));
await bus.publish("message.created", payload, { topics: ["channel:c1", "ws:w1"], actor });
bus.replay("channel:c1", afterSeq); // { kind: "events" | "gap" | "unknown_topic" }
```

Payloads are validated on publish; subscriber errors are reported through `onError` and never fail the
publisher; every topic keeps a per-topic `seq` and the last 1,000 events for WS resume (spec §7.2).
