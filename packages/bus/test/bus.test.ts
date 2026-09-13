import { describe, expect, test } from "bun:test";
import type { BusEvent } from "@perch/events";
import { createBus, InProcessBus, topicsFor } from "../src/index.ts";

const WS = "01926a1e-0000-7000-8000-000000000001";
const USER = "01926a1e-0000-7000-8000-000000000002";
const CHANNEL = "01926a1e-0000-7000-8000-000000000003";

describe("@perch/bus in-process", () => {
  test("publish validates the payload, stamps the envelope, and delivers to type and wildcard subscribers", async () => {
    const bus = createBus({ now: () => new Date("2026-09-13T00:00:00Z") });
    const seen: string[] = [];
    bus.subscribe("presence.changed", (e) => {
      seen.push(`typed:${e.payload.status}`);
    });
    bus.subscribe("*", (e) => {
      seen.push(`all:${e.type}`);
    });
    const { event, seqs } = await bus.publish(
      "presence.changed",
      { workspaceId: WS, userId: USER, status: "online" },
      { actor: { type: "user", id: USER } },
    );
    expect(seen.sort()).toEqual(["all:presence.changed", "typed:online"]);
    expect(event.ts).toBe("2026-09-13T00:00:00.000Z");
    expect(event.topics).toEqual([`ws:${WS}`]);
    expect(seqs).toEqual({ [`ws:${WS}`]: 1 });
    await expect(
      bus.publish("presence.changed", {
        workspaceId: WS,
        userId: USER,
        status: "asleep" as "online",
      }),
    ).rejects.toThrow();
  });

  test("a throwing subscriber never fails the publisher and is reported once", async () => {
    const errors: unknown[] = [];
    const bus = createBus({ onError: (err) => errors.push(err) });
    bus.subscribe("channel.created", () => {
      throw new Error("audit sink down");
    });
    const delivered: BusEvent[] = [];
    bus.subscribe("channel.created", (e) => {
      delivered.push(e);
    });
    await bus.publish("channel.created", { workspaceId: WS, channelId: CHANNEL, type: "public" });
    expect(errors).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  test("per-topic seq numbers, topic subscribers, and replay after a seq", async () => {
    const bus = new InProcessBus({ replayBuffer: 3 });
    const topic = `channel:${CHANNEL}`;
    const got: number[] = [];
    bus.subscribeTopic(topic, (_event, seq) => {
      got.push(seq);
    });
    for (let i = 0; i < 5; i++) {
      await bus.publish(
        "message.created",
        {
          workspaceId: WS,
          channelId: CHANNEL,
          messageId: USER,
          authorType: "user",
          authorId: USER,
        },
        { topics: [topic, `ws:${WS}`] },
      );
    }
    expect(got).toEqual([1, 2, 3, 4, 5]);
    expect(bus.seq(topic)).toBe(5);
    expect(bus.seq(`ws:${WS}`)).toBe(5);

    const tail = bus.replay(topic, 3);
    expect(tail.kind).toBe("events");
    if (tail.kind === "events") expect(tail.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(bus.replay(topic, 5)).toEqual({ kind: "events", events: [] });
    // Only the last 3 are buffered: after_seq 0 is a gap the client must refetch.
    expect(bus.replay(topic, 0)).toEqual({ kind: "gap", oldest: 3, latest: 5 });
    expect(bus.replay("session:nope", 0)).toEqual({ kind: "unknown_topic" });
  });

  test("unsubscribe stops delivery", async () => {
    const bus = createBus();
    let count = 0;
    const off = bus.subscribe("workspace.updated", () => {
      count += 1;
    });
    await bus.publish("workspace.updated", { workspaceId: WS });
    off();
    await bus.publish("workspace.updated", { workspaceId: WS });
    expect(count).toBe(1);
  });

  test("topicsFor defaults to the workspace topic and dedupes explicit topics", () => {
    expect(topicsFor({ workspaceId: WS })).toEqual([`ws:${WS}`]);
    expect(topicsFor({ workspaceId: WS }, ["a", "a", "b"])).toEqual(["a", "b"]);
    expect(topicsFor({})).toEqual([]);
  });
});
