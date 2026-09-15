import { expect, test } from "@playwright/test";
import { createWorkspace, PASSWORD, secondBrowser, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 0.10 acceptance (spec §7.2): two tabs see each other's presence over /api/ws, and a tab that
 * reconnects resumes from its last seq (the server side of resume is covered in apps/api/test/ws.test.ts).
 */

test("two tabs see each other's presence in a shared workspace", async ({ page, browser }) => {
  await signUp(page, "Dawn", uniqueEmail("dawn"));
  const workspaceName = `Presence ${Date.now()}`;
  const slug = await createWorkspace(page, workspaceName);
  await expect(page.getByTestId("online-count")).toHaveText("1 online");

  const inviteeEmail = uniqueEmail("julius");
  // From the page, so the request carries the session cookie and resolves the app's own hostname.
  const { accept_url } = await page.evaluate(async (email: string) => {
    const body = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: Array<{ id: string }>;
    };
    const workspaceId = body.workspaces[0]?.id ?? "";
    const invited = await fetch(`/api/workspaces/${workspaceId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role: "member" }),
    });
    return (await invited.json()) as { accept_url: string };
  }, inviteeEmail);

  const julius = await secondBrowser(browser);
  await julius.goto(new URL(accept_url).pathname);
  await julius.getByRole("link", { name: "Create an account to accept" }).click();
  await julius.getByLabel("Name").fill("Julius");
  await julius.getByLabel("Email").fill(inviteeEmail);
  await julius.getByLabel("Password").fill(PASSWORD);
  await julius.getByRole("button", { name: "Create account" }).click();
  await julius.getByRole("button", { name: "Accept invite" }).click();
  await expect(julius).toHaveURL(new RegExp(`/${slug}/home$`));
  await expect(julius.getByTestId("online-count")).toHaveText("2 online");
  await expect(page.getByTestId("online-count")).toHaveText("2 online");

  // A second tab for Dawn changes nothing (presence is per user); closing Julius drops him.
  const dawnTab2 = await page.context().newPage();
  await dawnTab2.goto(`/${slug}/home`);
  await expect(dawnTab2.getByTestId("online-count")).toHaveText("2 online");
  await julius.context().close();
  await expect(page.getByTestId("online-count")).toHaveText("1 online");
  await expect(dawnTab2.getByTestId("online-count")).toHaveText("1 online");
});
