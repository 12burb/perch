/**
 * Inbound webhooks (spec §3.5 "inbound webhooks at /hooks/:provider/:id with signature
 * verification → channel cards"; task 3.4).
 *
 * A webhook is a row: a provider, a channel, and a secret. What arrives at `/hooks/:provider/:id`
 * is checked against that secret with the provider's own scheme (ADR-0119), refused if it is a
 * replay, turned into a card in the channel, and offered to any bot whose spec says `on: webhook`.
 *
 * Nothing here trusts the body. It decides what the card says from a handful of fields it knows,
 * and everything it puts on screen is somebody else's words — clipped, never executed, never asked
 * of a model without the wrapper the bot runtime puts round untrusted text.
 */

import type { Bus } from "@perch/bus";
import { keyIsTheProviders, verifyDelivery, webhookSecret } from "@perch/connect";
import type { Db, MessageBlock, Webhook } from "@perch/db";
import type { Vault } from "@perch/vault";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import { getChannel } from "../repos/channels.ts";
import { insertMessage } from "../repos/messages.ts";
import {
  deleteWebhook,
  firstTime,
  getWebhook,
  insertWebhook,
  listWebhooks,
  touchWebhook,
} from "../repos/webhooks.ts";
import type { ConnectionsService } from "./connections.ts";

/** A body bigger than this is not a webhook, it is somebody having a go. */
export const MAX_DELIVERY_BYTES = 1024 * 1024;

export type WebhooksDeps = {
  db: Db;
  bus: Bus;
  vault: Vault;
  connections: Pick<ConnectionsService, "manifest" | "connectionFor">;
  /** A delivery may set a bot off (spec §5.3 `webhook` trigger). */
  bots: { onWebhook: (input: WebhookTrigger) => Promise<void> };
  log: Logger;
};

/**
 * `secret` is what somebody pastes into the provider, and is null for a provider whose key is its
 * own: with Ed25519 the pasting goes the other way (task 3.25).
 */
export type MadeWebhook = { webhook: Webhook; secret: string | null };

/** What a bot with an `on: webhook` trigger is handed (spec §5.3). */
export type WebhookTrigger = {
  workspaceId: string;
  channelId: string;
  provider: string;
  event: string | null;
  messageId: string;
  payload: Record<string, unknown>;
  by: ActorContext;
};

export type Delivered = {
  /** The message the card went into, when one was posted. */
  messageId: string | null;
  /** `duplicate` when the provider sent the same delivery twice. */
  status: "posted" | "duplicate";
};

export class WebhooksService {
  constructor(private readonly deps: WebhooksDeps) {}

  /** Makes an endpoint and hands back its secret exactly once. */
  async create(input: {
    workspaceId: string;
    provider: string;
    name: string;
    channelId: string;
    connectionId?: string | undefined;
    /** The provider's own verifying key, for a scheme where the key is theirs (task 3.25). */
    key?: string | undefined;
    createdBy: string;
    by: ActorContext;
  }): Promise<MadeWebhook> {
    // A provider Perch has no manifest for has no signature scheme either.
    const manifest = this.deps.connections.manifest(input.provider);
    const channel = await getChannel(this.deps.db, input.channelId);
    if (!channel || channel.workspaceId !== input.workspaceId) {
      throw PerchError.notFound("channel");
    }
    // A connection it names is one this person may use in this workspace (§3.5): an id that names
    // nothing, another workspace's, or somebody else's personal one is not found.
    const connection = input.connectionId
      ? await this.deps.connections.connectionFor(
          input.workspaceId,
          input.createdBy,
          input.connectionId,
        )
      : null;
    if (input.connectionId && !connection) throw PerchError.notFound("connection");
    const theirs = keyIsTheProviders(manifest);
    if (input.key !== undefined && !theirs) {
      throw PerchError.validation(
        `${manifest.name} is verified with a secret Perch generates, so there is no key to paste in`,
      );
    }
    // Discord signs with a private key nobody else has; what Perch needs is the public half, which
    // is on the application's own page. 32 bytes of hex, or it is not one.
    if (theirs && !/^[0-9a-fA-F]{64}$/.test((input.key ?? "").trim())) {
      throw PerchError.validation(
        `${manifest.name} signs with a key of its own: paste its public key (64 hex characters)`,
      );
    }
    const secret = theirs ? (input.key ?? "").trim().toLowerCase() : webhookSecret();
    const webhook = await insertWebhook(this.deps.db, {
      workspaceId: input.workspaceId,
      provider: input.provider,
      name: input.name,
      channelId: channel.id,
      connectionId: connection?.id ?? null,
      ciphertext: await this.deps.vault.encrypt(secret),
      createdBy: input.createdBy,
    });
    // Nothing to show once for a key that was theirs to begin with.
    return { webhook, secret: theirs ? null : secret };
  }

  list(workspaceId: string): Promise<Webhook[]> {
    return listWebhooks(this.deps.db, workspaceId);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return await deleteWebhook(this.deps.db, workspaceId, id);
  }

  /**
   * One delivery, start to finish. Every refusal is the same shape so the provider's retry logic
   * has something to work with, and none of them says why in a way that helps a guesser.
   */
  async deliver(input: {
    provider: string;
    id: string;
    headers: Headers;
    body: string;
    by: ActorContext;
  }): Promise<Delivered> {
    if (input.body.length > MAX_DELIVERY_BYTES) {
      throw PerchError.validation("that delivery is too big");
    }
    const webhook = await getWebhook(this.deps.db, input.id);
    // A wrong id and a wrong provider are the same answer: this endpoint is not here.
    if (!webhook || webhook.provider !== input.provider) throw PerchError.notFound("webhook");
    if (webhook.status !== "active") throw PerchError.notFound("webhook");
    const manifest = this.deps.connections.manifest(webhook.provider);
    const secret = await this.deps.vault.decryptString(webhook.ciphertext);

    const verdict = await verifyDelivery({
      manifest,
      headers: input.headers,
      body: input.body,
      secret,
    });
    if (!verdict.ok) {
      this.deps.log.warn(
        { webhookId: webhook.id, provider: webhook.provider, reason: verdict.reason },
        "a webhook delivery was refused",
      );
      throw PerchError.forbidden(verdict.reason, { rule: "webhook.signature" });
    }

    // The same delivery twice is one card. A provider that never heard the 200 will send again.
    const deliveryId = verdict.delivery.id ?? (await hashOf(input.body));
    if (
      !(await firstTime(this.deps.db, {
        webhookId: webhook.id,
        deliveryId,
        event: verdict.delivery.event,
      }))
    ) {
      return { messageId: null, status: "duplicate" };
    }
    await touchWebhook(this.deps.db, webhook.id);

    const payload = parse(input.body);
    const card = cardFor(webhook.provider, verdict.delivery.event, payload);
    const message = await insertMessage(this.deps.db, {
      workspaceId: webhook.workspaceId,
      channelId: webhook.channelId,
      authorType: "system",
      authorId: webhook.createdBy ?? webhook.id,
      blocks: [card] as MessageBlock[],
    });
    await this.deps.bus.publish(
      "message.created",
      {
        workspaceId: webhook.workspaceId,
        channelId: webhook.channelId,
        messageId: message.id,
        authorType: "system",
        authorId: webhook.createdBy ?? webhook.id,
      },
      input.by,
    );
    // And a bot may have been waiting for exactly this (spec §5.3's `webhook` trigger).
    await this.deps.bots
      .onWebhook({
        workspaceId: webhook.workspaceId,
        channelId: webhook.channelId,
        provider: webhook.provider,
        event: verdict.delivery.event,
        messageId: message.id,
        payload,
        by: input.by,
      })
      .catch((error: unknown) => {
        this.deps.log.warn({ err: error, webhookId: webhook.id }, "a webhook trigger failed");
      });
    return { messageId: message.id, status: "posted" };
  }
}

function parse(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown, max = 300): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function at(payload: Record<string, unknown>, path: string): unknown {
  let here: unknown = payload;
  for (const key of path.split(".")) {
    if (!here || typeof here !== "object") return undefined;
    here = (here as Record<string, unknown>)[key];
  }
  return here;
}

/**
 * What the card says. Perch knows a handful of shapes well enough to write a line about them; for
 * anything else the event's own name is the line, which is still worth a card.
 */
export function cardFor(
  provider: string,
  event: string | null,
  payload: Record<string, unknown>,
): MessageBlock {
  const fields: { label: string; value: string }[] = [];
  let title = event ?? "delivery";
  let url = str(payload.url ?? at(payload, "data.url") ?? "", 2_000);
  let text = "";

  if (event === "push") {
    const ref = str(payload.ref).replace(/^refs\/heads\//, "");
    const commits = Array.isArray(payload.commits) ? payload.commits.length : 0;
    const who = str(at(payload, "pusher.name") || at(payload, "sender.login"), 60);
    title = `${commits} commit${commits === 1 ? "" : "s"} on ${ref || "a branch"}`;
    if (who) fields.push({ label: "by", value: who });
    const repo = str(at(payload, "repository.full_name"), 120);
    if (repo) fields.push({ label: "repo", value: repo });
    url = url || str(payload.compare, 2_000);
    const first = Array.isArray(payload.commits) ? payload.commits[0] : null;
    text = str(
      first !== null && first !== undefined && typeof first === "object"
        ? ((first as { message?: unknown }).message ?? "")
        : "",
    );
  } else if (event?.startsWith("deployment")) {
    title = str(at(payload, "payload.name") || at(payload, "name"), 120) || event;
    url = url || str(at(payload, "payload.url"), 2_000);
    const target = str(at(payload, "payload.target"), 60);
    if (target) fields.push({ label: "target", value: target });
  } else if (event) {
    const name = str(at(payload, "data.id") || payload.id, 120);
    if (name) fields.push({ label: "id", value: name });
  }

  return {
    type: "webhook_card",
    provider,
    event: event ?? "delivery",
    title: title.slice(0, 300),
    ...(text ? { text: text.slice(0, 2_000) } : {}),
    ...(url ? { url } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  } as MessageBlock;
}

/** A provider that sends no delivery id still gets replay protection, from what it sent. */
async function hashOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 64);
}
