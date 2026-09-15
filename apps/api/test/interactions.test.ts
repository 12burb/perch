import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BotEvent } from "@perch/bots";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.5 (spec §5.2 "interactions post interaction.received {block id, values, user, message} to
 * the owning bot over the Bot API and update the block in place", §7.3).
 *
 * Both halves of that sentence are what this checks: the answer is written into the block, so the
 * message carries its own outcome and a second press finds it already answered; and the payload
 * reaches whoever is listening on the Bot API seam, in the shape §7.3 names.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ws = "";
let channel = "";
let wren = { cookie: "", id: "" };
let robin = { cookie: "", id: "" };
const seen: BotEvent[] = [];

beforeAll(async () => {
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  booted.botEvents.subscribe((event) => {
    seen.push(event);
  });
}, 60_000);

afterAll(async () => {
  await running.stop();
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string } };
  return { cookie, id: me.body.id };
}

type Block = {
  type: string;
  id?: string;
  decision?: string;
  state?: {
    byType: string;
    byId: string;
    byName?: string;
    at: string;
    values: Record<string, string>;
  };
};
type MessageBody = { id: string; blocks: Block[]; edited_at: string | null };
type Posted = { status: number; body: MessageBody };

const postBlocks = (cookie: string, blocks: unknown[]) =>
  call(`/api/workspaces/${ws}/channels/${channel}/messages`, cookie, {
    method: "POST",
    json: { blocks },
  }) as Promise<Posted>;

const press = (cookie: string, id: string, blockId: string, values?: Record<string, string>) =>
  call(`/api/workspaces/${ws}/messages/${id}/interactions`, cookie, {
    method: "POST",
    json: { block_id: blockId, ...(values ? { values } : {}) },
  }) as Promise<Posted>;

const approveBlock = (id: string) => ({
  type: "approve_deny",
  id,
  text: "Deploy 1.4.2?",
  action: "deploy",
});

describe("interactive blocks (task 2.5)", () => {
  test("an approve button answers the message in place and tells the Bot API", async () => {
    const stamp = Date.now();
    wren = await signUp("Wren", `wren-act-${stamp}@perch.test`);
    robin = await signUp("Robin", `robin-act-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", wren.cookie, {
      method: "POST",
      json: { name: "Block Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, wren.cookie, {
      method: "POST",
      json: { email: `robin-act-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, robin.cookie, { method: "POST" })).status,
    ).toBe(200);
    const created = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "public", name: "deploys" },
    })) as { body: { id: string } };
    channel = created.body.id;

    const asked = await postBlocks(wren.cookie, [
      { type: "text", text: "Ship it?" },
      approveBlock("deploy-1"),
    ]);
    expect(asked.status).toBe(201);

    // Everyone with the channel open is told the message changed (spec §7.7).
    const updates: string[] = [];
    const stop = booted.bus.subscribe("message.updated", (event) => {
      updates.push(event.payload.messageId);
    });

    seen.length = 0;
    const answered = await press(wren.cookie, asked.body.id, "deploy-1", { decision: "approved" });
    expect(answered.status).toBe(200);
    const block = answered.body.blocks[1];
    expect(block?.decision).toBe("approved");
    expect(block?.state?.byType).toBe("user");
    expect(block?.state?.byId).toBe(wren.id);
    expect(block?.state?.byName).toBe("Wren");
    expect(block?.state?.values).toEqual({ decision: "approved" });
    // Answering is not editing: no "(edited)" mark, and nothing in the history.
    expect(answered.body.edited_at).toBeNull();
    const history = (await call(
      `/api/workspaces/${ws}/messages/${asked.body.id}/edits`,
      wren.cookie,
    )) as { body: { edits: unknown[] } };
    expect(history.body.edits).toHaveLength(0);
    stop();
    expect(updates).toContain(asked.body.id);

    // The Bot API payload is spec §7.3's, and carries no credential of any kind (AGENTS §1.6).
    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(event?.type).toBe("interaction.received");
    expect(event?.workspaceId).toBe(ws);
    // Nothing owns the block until a bot can author a message (task 2.6).
    expect(event?.botId).toBeNull();
    expect(event?.payload).toEqual({
      workspace_id: ws,
      channel_id: channel,
      message_id: asked.body.id,
      block_id: "deploy-1",
      action: "deploy",
      block_type: "approve_deny",
      values: { decision: "approved" },
      user: { type: "user", id: wren.id, name: "Wren" },
      at: block?.state?.at ?? "",
    });

    // Whoever got there first is who it says.
    const again = await press(robin.cookie, asked.body.id, "deploy-1", { decision: "denied" });
    expect(again.status).toBe(409);
    const reread = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      wren.cookie,
    )) as { body: { messages: MessageBody[] } };
    expect(reread.body.messages[0]?.blocks[1]?.state?.values).toEqual({ decision: "approved" });
  });

  test("a select takes one of its options, a form takes its fields", async () => {
    const asked = await postBlocks(wren.cookie, [
      {
        type: "select",
        id: "env",
        text: "Where",
        action: "choose_env",
        options: [
          { label: "Staging", value: "staging" },
          { label: "Production", value: "production" },
        ],
      },
      {
        type: "form",
        id: "note",
        text: "Tell the team",
        action: "note",
        fields: [
          { name: "title", label: "Title", kind: "text", required: true },
          {
            name: "urgency",
            label: "Urgency",
            kind: "select",
            options: [{ label: "Now", value: "now" }],
          },
        ],
      },
    ]);
    expect(asked.status).toBe(201);

    const wrong = await press(wren.cookie, asked.body.id, "env", { value: "laptop" });
    expect(wrong.status).toBe(422);
    const chosen = await press(wren.cookie, asked.body.id, "env", { value: "production" });
    expect(chosen.status).toBe(200);
    expect(chosen.body.blocks[0]?.state?.values).toEqual({ value: "production" });

    const empty = await press(wren.cookie, asked.body.id, "note", { urgency: "now" });
    expect(empty.status).toBe(422);
    const badOption = await press(wren.cookie, asked.body.id, "note", {
      title: "Deploying",
      urgency: "whenever",
    });
    expect(badOption.status).toBe(422);
    const filled = await press(wren.cookie, asked.body.id, "note", {
      title: "Deploying",
      urgency: "now",
    });
    expect(filled.status).toBe(200);
    expect(filled.body.blocks[1]?.state?.values).toEqual({ title: "Deploying", urgency: "now" });
  });

  test("a block that is not there, and one that is not a question", async () => {
    const asked = await postBlocks(wren.cookie, [
      { type: "text", id: "words", text: "just talking" },
      approveBlock("deploy-2"),
    ]);
    expect((await press(wren.cookie, asked.body.id, "nothing-here")).status).toBe(404);
    expect((await press(wren.cookie, asked.body.id, "words")).status).toBe(409);
    // A progress block is the bot's to move, not a question anybody answers.
    const moving = await postBlocks(wren.cookie, [
      { type: "progress", id: "build", text: "Building", value: 0.4 },
    ]);
    expect((await press(wren.cookie, moving.body.id, "build")).status).toBe(409);
  });

  test("somebody outside the channel cannot answer, and a deleted message cannot either", async () => {
    const asked = await postBlocks(wren.cookie, [approveBlock("deploy-3")]);
    // Robin is in the workspace but not in this channel: reading is fine, answering is not.
    const outsider = await press(robin.cookie, asked.body.id, "deploy-3", { decision: "approved" });
    expect(outsider.status).toBe(409);

    expect(
      (
        await call(`/api/workspaces/${ws}/messages/${asked.body.id}`, wren.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    const gone = await press(wren.cookie, asked.body.id, "deploy-3", { decision: "approved" });
    expect(gone.status).toBe(409);
  });
});
