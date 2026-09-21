import { describe, expect, test } from "bun:test";
import { StreamHub } from "../src/runners/streams.ts";

/** The stream hub at shutdown (ADR-0163): nothing awaiting a runner's socket is left hanging. */
describe("the stream hub", () => {
  test("closing the hub fails what was still waiting, rather than leaving it pending for ever", async () => {
    const hub = new StreamHub(60_000);
    const waiting = hub.open("runner-1", "token-1");
    expect(hub.pending).toBe(1);
    hub.closeAll();
    await expect(waiting).rejects.toThrow("the api is shutting down");
    expect(hub.pending).toBe(0);
  });

  test("a stream nobody asked for within the wait is closed, and a late claim finds nothing", async () => {
    const hub = new StreamHub(10);
    const waiting = hub.open("runner-1", "token-2");
    await expect(waiting).rejects.toThrow("did not open stream token-2");
    expect(hub.pending).toBe(0);
  });
});
