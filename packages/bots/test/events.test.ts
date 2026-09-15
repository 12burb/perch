import { describe, expect, test } from "bun:test";
import {
  BOT_EVENTS,
  type BotEvent,
  createBotEvents,
  interactionReceivedSchema,
} from "../src/index.ts";

/**
 * Task 2.5: the Bot API event seam (spec §7.3). These are not bus events — the bus catalog is
 * §7.7's list and `packages/events` guards it — so this is where the outward-facing shape and the
 * dispatcher that hands it over are checked.
 */

const payload = {
  workspace_id: "8f2c0a3e-0000-4000-8000-000000000001",
  channel_id: "8f2c0a3e-0000-4000-8000-000000000002",
  message_id: "8f2c0a3e-0000-4000-8000-000000000003",
  block_id: "deploy-1",
  action: "deploy",
  block_type: "approve_deny" as const,
  values: { decision: "approved" },
  user: { type: "user" as const, id: "8f2c0a3e-0000-4000-8000-000000000004", name: "Wren" },
  at: "2026-09-15T10:31:00.000Z",
};

const event: BotEvent<"interaction.received"> = {
  type: "interaction.received",
  botId: null,
  workspaceId: payload.workspace_id,
  payload,
  ts: payload.at,
};

describe("bot events (task 2.5)", () => {
  test("the catalog is spec §7.3's, and nothing else", () => {
    expect([...BOT_EVENTS]).toEqual([
      "message.created",
      "app_mention",
      "reaction.added",
      "channel.joined",
      "interaction.received",
      "session.completed",
      "work_item.updated",
    ]);
  });

  test("interaction.received carries the block, its values, and who acted", () => {
    expect(interactionReceivedSchema.parse(payload)).toEqual(payload);
    // Nothing else rides along: a bot is told what happened, never how to reach anything.
    expect(interactionReceivedSchema.safeParse({ ...payload, token: "secret" }).success).toBe(
      false,
    );
    expect(
      interactionReceivedSchema.safeParse({ ...payload, block_type: "progress" }).success,
    ).toBe(false);
    expect(interactionReceivedSchema.safeParse({ ...payload, block_id: "" }).success).toBe(false);
  });

  test("every subscriber is handed the event, and one that throws never fails the caller", async () => {
    const errors: unknown[] = [];
    const events = createBotEvents({ onError: (error) => errors.push(error) });
    const got: BotEvent[] = [];
    events.subscribe(() => {
      throw new Error("the webhook is down");
    });
    const stop = events.subscribe((one) => {
      got.push(one);
    });

    await events.emit(event);
    expect(got).toHaveLength(1);
    expect(got[0]?.payload).toEqual(payload);
    expect(errors).toHaveLength(1);

    // Gone once it unsubscribes, and an event with nobody listening is not an error.
    stop();
    await events.emit(event);
    expect(got).toHaveLength(1);
    await createBotEvents().emit(event);
  });
});
