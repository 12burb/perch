import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  createWorkspace,
  isMobile,
  PASSWORD,
  secondBrowser,
  signUp,
  uniqueEmail,
} from "./helpers.ts";

/**
 * Task 2.1 (spec §4 sidebar sections, §5.2): channels as rooms. The acceptance is the four things a
 * person does with one — create, join, leave, archive — driven at both viewports, with a second
 * person in a second browser doing the joining and the leaving, because that is the only way to
 * prove a channel is open to somebody who did not make it.
 *
 * Messages are task 2.2; a channel with nothing in it says so.
 */

test("create a channel, another member joins and leaves, an admin archives it", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Channel Owner", uniqueEmail("chan"));
  const slug = await createWorkspace(page, "Chat Nest");

  // Create: Home's main has the browser and the form that starts one.
  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("Release Notes");
  await form.getByLabel("Topic").fill("what shipped");
  await form.getByRole("button", { name: "Create channel" }).click();

  // It opens, named the way a channel is named, with its maker in it.
  const channel = page.getByRole("region", { name: "#release-notes" });
  await expect(channel).toBeVisible({ timeout: 30_000 });
  await expect(channel.getByRole("heading", { name: "#release-notes" })).toBeVisible();
  await expect(channel.getByTestId("channel-members")).toHaveText("1 in here");
  await expect(channel.getByText("Nothing has been said here yet.")).toBeVisible();
  const channelUrl = page.url();

  // The topic is a member's to set, and it sticks.
  await channel.getByLabel("Topic").fill("release week");
  await channel.getByRole("button", { name: "Save topic" }).click();
  await expect(channel.getByLabel("Topic")).toHaveValue("release week");

  // The sidebar lists it. Its link is named with the hash; the browser's row in main is named
  // "Open …", so this one is the sidebar's and nothing else. On a phone the sidebar is a sheet.
  const inSidebar = page.getByRole("link", { name: "#release-notes" });
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(inSidebar).toBeVisible();
  // The sheet covers the toggle that opened it, so Esc is what closes it.
  if (mobile) await page.keyboard.press("Escape");

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // A second person in the workspace: invited from the page, so the call carries the session.
  const inviteeEmail = uniqueEmail("robin");
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

  const robin = await secondBrowser(browser);
  await robin.goto(new URL(accept_url).pathname);
  await robin.getByRole("link", { name: "Create an account to accept" }).click();
  await robin.getByLabel("Name").fill("Robin");
  await robin.getByLabel("Email").fill(inviteeEmail);
  await robin.getByLabel("Password").fill(PASSWORD);
  await robin.getByRole("button", { name: "Create account" }).click();
  await robin.getByRole("button", { name: "Accept invite" }).click();
  await expect(robin).toHaveURL(new RegExp(`/${slug}/home$`));

  // Join: a public channel is open to everybody in the workspace, from the browser in main.
  const row = robin.getByTestId("channel-row").filter({ hasText: "release-notes" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Join" }).click();
  await expect(row.getByRole("button", { name: "Join" })).toBeHidden();
  await expect(page.getByTestId("channel-members")).toHaveText("2 in here", { timeout: 30_000 });

  // Leave: from inside the channel, and it puts them back on Home.
  await row.getByRole("link", { name: "Open release-notes" }).click();
  const robinChannel = robin.getByRole("region", { name: "#release-notes" });
  await expect(robinChannel).toBeVisible();
  await robinChannel.getByRole("button", { name: "Leave" }).click();
  await expect(robin).toHaveURL(new RegExp(`/${slug}/home$`));
  await expect(page.getByTestId("channel-members")).toHaveText("1 in here", { timeout: 30_000 });

  // Archive: the owner puts it away, and it is marked and gone from the sidebar.
  await page.goto(channelUrl);
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(channel.getByText("Archived")).toBeVisible({ timeout: 30_000 });
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(inSidebar).toBeHidden();

  // A member may not archive anything: Robin has no such button.
  await robin.goto(channelUrl);
  await expect(robin.getByRole("button", { name: "Archive" })).toBeHidden();
  await robin.context().close();
});
