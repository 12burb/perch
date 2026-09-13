import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Task 0.10 acceptance (spec §7.2): two tabs see each other's presence over /api/ws, and a tab that
 * reconnects resumes from its last seq (the server side of resume is covered in apps/api/test/ws.test.ts).
 */

const PASSWORD = "correct horse battery staple";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("signed-in-as")).toHaveText(`Signed in as ${name}`);
}

async function secondBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test("two tabs see each other's presence in a shared workspace", async ({ page, browser }) => {
  await signUp(page, "Dawn", uniqueEmail("dawn"));
  const workspaceName = `Presence ${Date.now()}`;
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  const item = page
    .getByRole("list", { name: "Your workspaces" })
    .getByRole("listitem")
    .filter({ hasText: workspaceName });
  await expect(item.getByTestId("online-count")).toHaveText("1 online");
  const workspaceId = await item.getAttribute("data-workspace-id");

  const inviteeEmail = uniqueEmail("julius");
  const invited = await page.request.post(`/api/workspaces/${workspaceId}/invites`, {
    data: { email: inviteeEmail, role: "member" },
  });
  const { accept_url } = (await invited.json()) as { accept_url: string };

  const julius = await secondBrowser(browser);
  await julius.goto(new URL(accept_url).pathname);
  await julius.getByRole("link", { name: "Create an account to accept" }).click();
  await julius.getByLabel("Name").fill("Julius");
  await julius.getByLabel("Email").fill(inviteeEmail);
  await julius.getByLabel("Password").fill(PASSWORD);
  await julius.getByRole("button", { name: "Create account" }).click();
  await julius.getByRole("button", { name: "Accept invite" }).click();
  const juliusItem = julius
    .getByRole("list", { name: "Your workspaces" })
    .getByRole("listitem")
    .filter({ hasText: workspaceName });
  await expect(juliusItem.getByTestId("online-count")).toHaveText("2 online");
  await expect(item.getByTestId("online-count")).toHaveText("2 online");

  // A second tab for Dawn changes nothing (presence is per user); closing Julius drops him.
  const dawnTab2 = await page.context().newPage();
  await dawnTab2.goto("/");
  const tab2Item = dawnTab2
    .getByRole("list", { name: "Your workspaces" })
    .getByRole("listitem")
    .filter({ hasText: workspaceName });
  await expect(tab2Item.getByTestId("online-count")).toHaveText("2 online");
  await julius.context().close();
  await expect(item.getByTestId("online-count")).toHaveText("1 online");
  await expect(tab2Item.getByTestId("online-count")).toHaveText("1 online");
});
