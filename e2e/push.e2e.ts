import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.3, the acceptance from the browser's side: a push arrives on a phone and Perch says so.
 *
 * A real subscription needs a real push service (Google's, Mozilla's), which a test machine has
 * none of — so the message is delivered to the worker the way the browser itself would deliver it,
 * through the DevTools protocol. Everything after that point is Perch's: the worker decodes it,
 * shows the notification, and tells the open tab, which is what this asserts. The other half — that
 * Perch encrypts and POSTs exactly this, for exactly the people who were mentioned — is
 * `apps/api/test/push.test.ts`, which decrypts the body as a browser would.
 */

test("the worker registers, and a push shows up in the app", async ({ page, context }) => {
  test.setTimeout(120_000);
  await signUp(page, "Wren", uniqueEmail("wren"));
  const slug = await createWorkspace(page, "Push Nest");
  const origin = new URL(page.url()).origin;
  await context.grantPermissions(["notifications"], { origin });

  // The app registers the worker on boot; nothing else in the app waits for it.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration("/");
          return Boolean(registration?.active ?? registration?.installing ?? registration?.waiting);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  // Settings says where this device stands, and offers to turn notifications on.
  await page.goto("/settings/profile");
  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect(notifications).toBeVisible();
  await expect(notifications.getByRole("button", { name: "Notify this device" })).toBeVisible({
    timeout: 30_000,
  });

  // A push, delivered to the worker the way the browser would deliver one.
  const cdp = await context.newCDPSession(page);
  let registrationId = "";
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event: unknown) => {
    const { registrations } = event as { registrations: { registrationId: string }[] };
    registrationId = registrations[0]?.registrationId ?? registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrationId, { timeout: 30_000 }).not.toBe("");

  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin,
    registrationId,
    data: JSON.stringify({
      title: "Robin in #general",
      body: "over to you @wren",
      url: `/${slug}/home`,
      tag: "channel:general",
    }),
  });

  const toast = page.getByTestId("push-toast");
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("Robin in #general");
  await expect(toast).toContainText("over to you @wren");
  // It is a live region, so it is announced rather than merely drawn.
  await expect(page.getByTestId("push-toasts")).toHaveAttribute("aria-live", "polite");

  // Following it lands where the message was said; dismissing it takes it away.
  await toast.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/home`));
});
