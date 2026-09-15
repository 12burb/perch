/**
 * Web push (spec §5.2 "mute prefs, web push", §5.7 "the phone gets what needs a human"; task 2.3).
 *
 * A subscription is a browser's own: an endpoint at whatever push service that browser uses, and
 * the keys the payload is encrypted to. Perch stores those, encrypts every message to them
 * (`push-crypto.ts`), and POSTs it. The push service is handed ciphertext and a VAPID assertion and
 * learns nothing else — not who it is for, not what it says.
 *
 * The instance's VAPID key pair is made on first use and kept in `instance_settings`, the private
 * half through the vault, so a laptop-mode Perch needs no configuration to notify anybody.
 */
import type { Db, PushSubscription } from "@perch/db";
import { schema } from "@perch/db";
import type { Vault } from "@perch/vault";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPush,
  generateVapidKeys,
  type VapidKeys,
  vapidAuthorization,
} from "./push-crypto.ts";
import { getSetting, setSetting } from "./setup.ts";

const { pushSubscriptions } = schema;

const PUBLIC_KEY = "push.vapid_public_key";
const PRIVATE_KEY = "push.vapid_private_key";
/** The context the private key is sealed under, so a ciphertext from elsewhere will not open. */
const VAULT_AAD = "push:vapid";

/** What a notification says. Short, because a phone shows two lines of it. */
export type PushMessage = {
  title: string;
  body: string;
  /** Where tapping it should land, as a path in this Perch. */
  url: string;
  /** What the notification replaces, so ten mentions in a channel are not ten notifications. */
  tag?: string;
};

export type PushDeps = {
  db: { db: Db };
  vault: Vault;
  env: { publicUrl: string };
};

/**
 * The instance's VAPID keys, made once. The public half is handed to browsers; the private half
 * never leaves this process in the clear.
 */
export async function vapidKeys(deps: PushDeps): Promise<VapidKeys> {
  const publicKey = await getSetting<string>(deps.db.db, PUBLIC_KEY);
  const sealed = await getSetting<string>(deps.db.db, PRIVATE_KEY);
  if (publicKey && sealed) {
    const privateKey = await deps.vault.decryptString(base64UrlDecode(sealed), VAULT_AAD);
    return { publicKey, privateKey };
  }
  const fresh = await generateVapidKeys();
  await setSetting(deps.db.db, PUBLIC_KEY, fresh.publicKey);
  await setSetting(
    deps.db.db,
    PRIVATE_KEY,
    base64UrlEncode(await deps.vault.encrypt(fresh.privateKey, VAULT_AAD)),
  );
  return fresh;
}

/** The key a browser needs before it can subscribe at all. */
export async function publicKey(deps: PushDeps): Promise<string> {
  return (await vapidKeys(deps)).publicKey;
}

/**
 * Who the push service should complain to (RFC 8292 §2.1): a URL, not an address, so nothing about
 * the instance's people is handed over with every message.
 */
function subjectOf(deps: PushDeps): string {
  return deps.env.publicUrl;
}

export async function subscribe(
  deps: PushDeps,
  input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | undefined;
  },
): Promise<PushSubscription> {
  const values = {
    userId: input.userId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent ?? null,
    expiredAt: null,
  };
  // An endpoint is a device: the same one subscribing again is the same row, moved to whoever is
  // signed in on it now.
  const [row] = await deps.db.db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("push subscription insert returned no row");
  return row;
}

export async function unsubscribe(deps: PushDeps, userId: string, endpoint: string): Promise<void> {
  await deps.db.db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

/** Somebody's live subscriptions, newest first; the ones a push service has retired are left out. */
export async function subscriptionsOf(db: Db, userId: string): Promise<PushSubscription[]> {
  return db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.expiredAt)))
    .orderBy(desc(pushSubscriptions.createdAt));
}

/** How long a push service should hold a message for a phone that is off: long enough to matter. */
const TTL_SECONDS = 12 * 60 * 60;

export type Delivery = { ok: boolean; status: number; gone: boolean };

/**
 * One message to one device. A 404 or 410 is the push service saying that browser is gone for good,
 * and the subscription is retired rather than retried.
 */
export async function deliver(
  deps: PushDeps,
  subscription: PushSubscription,
  message: PushMessage,
  fetcher: typeof fetch = fetch,
): Promise<Delivery> {
  const keys = await vapidKeys(deps);
  const body = await encryptPush(new TextEncoder().encode(JSON.stringify(message)), subscription);
  const authorization = await vapidAuthorization(keys, {
    endpoint: subscription.endpoint,
    subject: subjectOf(deps),
  });
  let status = 0;
  try {
    const res = await fetcher(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(TTL_SECONDS),
        urgency: "normal",
      },
      body,
    });
    status = res.status;
  } catch {
    // A push service that cannot be reached is not a subscription that is gone.
    return { ok: false, status: 0, gone: false };
  }
  const gone = status === 404 || status === 410;
  if (gone) {
    await deps.db.db
      .update(pushSubscriptions)
      .set({ expiredAt: new Date(), updatedAt: new Date() })
      .where(eq(pushSubscriptions.id, subscription.id));
  } else if (status >= 200 && status < 300) {
    await deps.db.db
      .update(pushSubscriptions)
      .set({ lastSentAt: new Date(), updatedAt: new Date() })
      .where(eq(pushSubscriptions.id, subscription.id));
  }
  return { ok: status >= 200 && status < 300, status, gone };
}

/** Every device one person has, told the same thing. */
export async function notify(
  deps: PushDeps,
  userId: string,
  message: PushMessage,
  fetcher: typeof fetch = fetch,
): Promise<Delivery[]> {
  const subscriptions = await subscriptionsOf(deps.db.db, userId);
  const out: Delivery[] = [];
  for (const subscription of subscriptions) {
    out.push(await deliver(deps, subscription, message, fetcher));
  }
  return out;
}
