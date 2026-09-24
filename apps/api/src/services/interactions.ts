/**
 * Interactive blocks (spec §5.2 "interactions post `interaction.received` {block id, values, user,
 * message} to the owning bot over the Bot API and update the block in place", §7.3; task 2.5).
 *
 * Two things happen when somebody presses a button, and both matter. The block is answered in
 * place, so the message carries its own outcome and everybody — including whoever opens it
 * tomorrow — sees the same thing. And the payload goes to whoever owns the block over the Bot API
 * seam, which is how a bot learns that its question was answered (the transports arrive with the
 * runtime in 2.6).
 */
import type { BotEvents, InteractionReceived } from "@perch/bots";
import type { Bus } from "@perch/bus";
import type { BlockState, Channel, Db, Message, MessageBlock } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { rewriteMessageBlocks } from "../repos/messages.ts";
import { requireWriteable } from "./messages.ts";

export type InteractionDeps = { db: { db: Db }; bus: Bus; botEvents: BotEvents };

/** The blocks a person can act on. `progress` is the bot's to move, so it is not one of them. */
const INTERACTIVE = ["button", "select", "form", "approve_deny"] as const;
export type InteractiveType = (typeof INTERACTIVE)[number];

type Interactive = Extract<MessageBlock, { type: InteractiveType }>;

function isInteractive(block: MessageBlock): block is Interactive {
  return (INTERACTIVE as readonly string[]).includes(block.type);
}

/**
 * Blocks are addressed by their `id`. A block without one cannot be acted on — there would be no
 * way to say which of two buttons was pressed, or to write the answer back to the right one.
 */
export function findBlock(message: Message, blockId: string): { block: Interactive; at: number } {
  const at = message.blocks.findIndex((block) => "id" in block && block.id === blockId);
  const block = message.blocks[at];
  if (at < 0 || !block) throw PerchError.notFound("block");
  if (!isInteractive(block)) throw PerchError.conflict("that block is not one to act on");
  return { block, at };
}

/**
 * What a person's action says, checked against the block that offered it: a select takes one of its
 * options, a form takes its fields (and all the required ones), approve_deny takes a decision, and
 * a button takes the value it was given. Anything else is not an answer to this question.
 */
export function readValues(
  block: Interactive,
  given: Record<string, string>,
): Record<string, string> {
  if (block.type === "button") {
    return { value: block.value ?? given.value ?? "" };
  }
  if (block.type === "select") {
    const value = given.value ?? "";
    if (!block.options.some((option) => option.value === value)) {
      throw PerchError.validation("that is not one of the options");
    }
    return { value };
  }
  if (block.type === "approve_deny") {
    const decision = given.decision ?? "";
    if (decision !== "approved" && decision !== "denied") {
      throw PerchError.validation("a decision is approved or denied");
    }
    return { decision };
  }
  const values: Record<string, string> = {};
  for (const field of block.fields) {
    const value = given[field.name] ?? "";
    if (field.required && value.trim() === "") {
      throw PerchError.validation(`${field.label} is needed`);
    }
    if (field.kind === "select" && value !== "") {
      const options = field.options ?? [];
      if (!options.some((option) => option.value === value)) {
        throw PerchError.validation(`${field.label} is not one of its options`);
      }
    }
    if (value !== "") values[field.name] = value;
  }
  return values;
}

/** The block, answered. A resolved block keeps what it said and gains who said what to it. */
export function resolve(block: Interactive, state: BlockState): Interactive {
  if (block.type === "approve_deny") {
    const decision = state.values.decision === "denied" ? "denied" : "approved";
    return { ...block, decision, state };
  }
  return { ...block, state };
}

export type ActInput = {
  channel: Channel;
  message: Message;
  userId: string;
  userName?: string | undefined;
  blockId: string;
  values: Record<string, string>;
  by: ActorContext;
};

export type ActResult = { message: Message; event: InteractionReceived };

/**
 * Pressing the button. Being in the channel is what allows it — the same rule as saying something
 * there — and a block that has already been answered is not answered twice: whoever got there
 * first is who it says.
 *
 * "First" is decided against the row, not against the copy this request read: the answer is
 * written while the row is locked, after checking the block as it is at that moment. Two presses
 * at once are one answer and one conflict, one `interaction.received`, and an answer to another
 * block on the same card is written beside it rather than over it.
 */
export async function act(deps: InteractionDeps, input: ActInput): Promise<ActResult> {
  await requireWriteable(deps, input.channel, input.userId);
  if (input.message.deletedAt) throw PerchError.conflict("that message is gone");
  // A wrong block or a wrong answer is refused against what was read, before anything is locked.
  const read = findBlock(input.message, input.blockId);
  if (read.block.state) throw PerchError.conflict("somebody has already answered that");
  readValues(read.block, input.values);

  const at = new Date().toISOString();
  const answered: { block?: Interactive; state?: BlockState } = {};
  // The edit is the api's, not the author's: it is the answer being recorded, not a rewrite, so it
  // keeps no edit history and sets no "(edited)" mark.
  const message = await rewriteMessageBlocks(
    deps.db.db,
    input.message.id,
    (current) => {
      const found = findBlock(current, input.blockId);
      if (found.block.state) throw PerchError.conflict("somebody has already answered that");
      const state: BlockState = {
        byType: "user",
        byId: input.userId,
        ...(input.userName ? { byName: input.userName } : {}),
        at,
        values: readValues(found.block, input.values),
      };
      answered.block = found.block;
      answered.state = state;
      const blocks = [...current.blocks];
      blocks[found.at] = resolve(found.block, state);
      return blocks;
    },
    { type: "system", id: input.userId, history: false },
  );
  const { block, state } = answered;
  if (!message || !block || !state) throw PerchError.conflict("that message is gone");

  const event: InteractionReceived = {
    workspace_id: input.channel.workspaceId,
    channel_id: input.channel.id,
    message_id: input.message.id,
    block_id: input.blockId,
    action: block.action,
    block_type: block.type,
    values: state.values,
    user: {
      type: "user",
      id: input.userId,
      ...(input.userName ? { name: input.userName } : {}),
    },
    at: state.at,
  };
  // Whoever wrote the message owns its blocks; until bots can author one (task 2.6) that is a
  // person, and nothing is listening yet.
  await deps.botEvents.emit({
    type: "interaction.received",
    botId: input.message.authorType === "bot" ? input.message.authorId : null,
    workspaceId: input.channel.workspaceId,
    payload: event,
    ts: state.at,
  });
  // Everybody with the channel open sees the block answer itself.
  await deps.bus.publish(
    "message.updated",
    {
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      messageId: input.message.id,
    },
    input.by,
  );
  return { message, event };
}
