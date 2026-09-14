import { expect, test } from "@playwright/test";
import { PASSWORD } from "./helpers.ts";

/**
 * Task 0.13 acceptance (spec §8): the first run lands on the setup wizard (admin, workspace,
 * PERCH_PUBLIC_URL, telemetry checkbox) and ends signed in; afterwards the wizard is gone. The wizard
 * is one-time per database, so this spec drives it only when the server was started with
 * E2E_SETUP=wizard; otherwise it checks that a set-up instance never shows it.
 */

test("first run: the wizard creates the admin and workspace, then disappears", async ({
  page,
  request,
}) => {
  const instance = (await (await request.get("/api/instance")).json()) as {
    setup_complete: boolean;
    public_url: string;
  };
  if (instance.setup_complete) {
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/sign-in/);
    await page.goto("/sign-up");
    await expect(page.getByRole("heading", { name: "Create your Perch account" })).toBeVisible();
    return;
  }

  // Every entry point redirects to the wizard, and nobody can sign up before it.
  await page.goto("/sign-up");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up Perch" })).toBeVisible();
  const blocked = await request.post("/api/auth/sign-up/email", {
    data: { name: "Eve", email: "eve@example.test", password: PASSWORD },
  });
  expect(blocked.status()).toBe(403);

  await page.getByLabel("Name", { exact: true }).fill("Dawn Bird");
  await page.getByLabel("Email").fill("dawn@example.test");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Workspace name").fill("The Nest");
  await expect(page.getByLabel(/Public URL/)).toHaveValue(instance.public_url);
  // A wrong URL is refused with the configured value; the wizard never overrides .env.
  await page.getByLabel(/Public URL/).fill("https://elsewhere.example.com");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("alert")).toContainText(instance.public_url);
  await page.getByLabel(/Public URL/).fill(instance.public_url);
  await page.getByLabel(/anonymous ping/).check();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page).toHaveURL(/\/the-nest\/home$/);
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as Dawn Bird");
  const after = (await (await request.get("/api/instance")).json()) as {
    setup_complete: boolean;
    telemetry: boolean;
  };
  expect(after).toMatchObject({ setup_complete: true, telemetry: true });
  await page.goto("/setup");
  await expect(page).not.toHaveURL(/\/setup$/);
});
