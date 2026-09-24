/**
 * Web push, the browser's half (task 2.3): registering the worker, asking once, and telling Perch
 * where this device can be reached.
 *
 * Everything here is allowed to be absent. A browser without push, a page that is not on a secure
 * origin, and a person who said no all arrive at the same place: `state()` says why, and nothing
 * else in the app has to care.
 */
import { api, unwrap } from "./api.ts";

export type PushState = "unsupported" | "denied" | "off" | "on";

let registration: ServiceWorkerRegistration | null = null;

/** Registers the worker once. Returns null where service workers are not a thing. */
export async function ensureWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (registration) return registration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return registration;
  } catch {
    return null;
  }
}

export function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Where this device stands: told off, never asked, or already subscribed. */
export async function state(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const worker = await ensureWorker();
  const subscription = await worker?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}

/** The VAPID key as the buffer `pushManager.subscribe` wants. */
function keyBuffer(base64Url: string): ArrayBuffer {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

function keyString(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Asks the browser, then this Perch. Returns where the device ended up. */
export async function turnOn(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const worker = await ensureWorker();
  if (!worker) return "unsupported";
  const { public_key } = unwrap(await api.GET("/api/me/push-key", {}));
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBuffer(public_key),
    }));
  unwrap(
    await api.POST("/api/me/push-subscriptions", {
      body: {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: keyString(subscription.getKey("p256dh")),
          auth: keyString(subscription.getKey("auth")),
        },
      },
    }),
  );
  return "on";
}

/** Tells Perch to stop, and the browser to forget: the notification stops either way. */
export async function turnOff(): Promise<PushState> {
  const worker = await ensureWorker();
  const subscription = await worker?.pushManager.getSubscription();
  if (subscription) {
    await api.DELETE("/api/me/push-subscriptions", { body: { endpoint: subscription.endpoint } });
    await subscription.unsubscribe();
  }
  return "off";
}

/** How long sign-out waits on this device's push subscription before it goes on without it. */
const RELEASE_WAIT_MS = 5_000;

/**
 * Sign-out's half (A-wc-11): this device stops receiving the signed-out person's notifications,
 * and their message previews stop reaching whoever signs in next. Perch forgets the subscription
 * first, while the session cookie still works; the browser then forgets it whatever Perch
 * answered, which also leaves a dead endpoint behind any row that stayed. It registers no worker
 * (a device that never had one has nothing to release), never throws, and gives up after a few
 * seconds: sign-out goes on whatever happens here.
 */
export async function releaseForSignOut(): Promise<void> {
  if (!supported()) return;
  const release = async () => {
    const worker = registration ?? (await navigator.serviceWorker.getRegistration()) ?? null;
    const subscription = await worker?.pushManager.getSubscription();
    if (!subscription) return;
    try {
      await api.DELETE("/api/me/push-subscriptions", {
        body: { endpoint: subscription.endpoint },
      });
    } finally {
      await subscription.unsubscribe();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      release(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RELEASE_WAIT_MS);
      }),
    ]);
  } catch {
    // Best effort by design: an unreachable api or push service does not keep anyone signed in.
  } finally {
    clearTimeout(timer);
  }
}

export type PushNote = { title: string; body: string; url: string; tag: string };

/** What the worker passes on while a tab is open, so the app can say it in place. */
export function onPush(handler: (note: PushNote) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as Partial<PushNote> & { type?: string };
    if (data?.type !== "push") return;
    handler({
      title: String(data.title ?? ""),
      body: String(data.body ?? ""),
      url: String(data.url ?? "/"),
      tag: String(data.tag ?? "perch"),
    });
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
