import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "../src/lib/api.ts";
import { releaseForSignOut } from "../src/lib/push.ts";

/**
 * Sign-out releases this device's push subscription (A-wc-11): Perch forgets it while the session
 * still works, then the browser does, whatever Perch answered; and sign-out is never held up.
 * The browser's push objects are stand-ins; `bun test` has no service worker.
 */

type Calls = string[];

const scope = globalThis as Record<string, unknown>;
const saved = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  del: api.DELETE,
};

/** A browser with push, and a subscription (or none) in its worker. */
function browser(calls: Calls, subscribed: boolean): void {
  const subscription = {
    endpoint: "https://push.example.test/device-1",
    unsubscribe: async () => {
      calls.push("unsubscribe");
      return true;
    },
  };
  scope.window = { PushManager: class {}, Notification: class {} };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: { getSubscription: async () => (subscribed ? subscription : null) },
        }),
      },
    },
  });
}

/** The api's DELETE as a stand-in that records what it was asked and answers as told. */
function deleteAnswers(calls: Calls, answer: () => Promise<unknown>): void {
  const stand = async (path: string, init: { body: { endpoint: string } }) => {
    calls.push(`DELETE ${path} ${init.body.endpoint}`);
    return answer();
  };
  api.DELETE = stand as unknown as typeof api.DELETE;
}

beforeEach(() => {
  api.DELETE = saved.del;
});

afterEach(() => {
  api.DELETE = saved.del;
  if (saved.window) Object.defineProperty(globalThis, "window", saved.window);
  else delete scope.window;
  if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
});

describe("releaseForSignOut", () => {
  test("tells Perch to forget the device, then the browser", async () => {
    const calls: Calls = [];
    browser(calls, true);
    deleteAnswers(calls, async () => ({ response: new Response(null, { status: 204 }) }));
    await releaseForSignOut();
    expect(calls).toEqual([
      "DELETE /api/me/push-subscriptions https://push.example.test/device-1",
      "unsubscribe",
    ]);
  });

  test("the browser forgets the device even when Perch cannot be reached, and nothing throws", async () => {
    const calls: Calls = [];
    browser(calls, true);
    deleteAnswers(calls, async () => {
      throw new TypeError("network down");
    });
    await releaseForSignOut();
    expect(calls).toEqual([
      "DELETE /api/me/push-subscriptions https://push.example.test/device-1",
      "unsubscribe",
    ]);
  });

  test("a device with no subscription has nothing to release", async () => {
    const calls: Calls = [];
    browser(calls, false);
    deleteAnswers(calls, async () => ({ response: new Response(null, { status: 204 }) }));
    await releaseForSignOut();
    expect(calls).toEqual([]);
  });

  test("a browser without push is left alone", async () => {
    const calls: Calls = [];
    deleteAnswers(calls, async () => ({ response: new Response(null, { status: 204 }) }));
    await releaseForSignOut();
    expect(calls).toEqual([]);
  });
});
