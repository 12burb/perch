/**
 * Perch's service worker (task 2.3). It exists for one thing so far: a push message arriving while
 * nobody is looking at the tab, which is what makes a mention reach a phone.
 *
 * It caches nothing. Offline is not promised yet, and a stale shell would be worse than a slow one.
 */

self.addEventListener("install", () => {
  // The newest worker takes over immediately: an old one would show the old notification.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { title: "Perch", body: event.data ? event.data.text() : "" };
  }
  const title = typeof message.title === "string" && message.title ? message.title : "Perch";
  const body = typeof message.body === "string" ? message.body : "";
  const url = typeof message.url === "string" && message.url ? message.url : "/";
  const tag = typeof message.tag === "string" && message.tag ? message.tag : "perch";

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        tag,
        data: { url },
        // A mention is somebody talking to you: it may make a sound and stay on screen.
        renotify: true,
      });
      // A tab that is open hears about it too, so the app can say so in place.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: "push", title, body, url, tag });
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
