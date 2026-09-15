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
 * Task 2.2 (spec §5.2): what is said in a channel. Everything the task names, in the order a
 * conversation actually goes: a message, a mention picked from the list, a reply in a thread, the
 * hover toolbar's pin and save, an edit with its history, a delete, and the unread count going back
 * to nothing when the other person reads it.
 *
 * Two browsers, because a message is only a message when somebody else sees it.
 */

test("say it, mention, thread, pin, save, edit, delete — and the unread clears", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Wren", uniqueEmail("wren"));
  const slug = await createWorkspace(page, "Talk Nest");

  // A channel to talk in.
  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("general");
  await form.getByRole("button", { name: "Create channel" }).click();
  const channel = page.getByRole("region", { name: "#general" });
  await expect(channel).toBeVisible({ timeout: 30_000 });
  const channelUrl = page.url();

  // A second person in the workspace, and in the channel.
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
  const robinRow = robin.getByTestId("channel-row").filter({ hasText: "general" });
  await robinRow.getByRole("button", { name: "Join" }).click();
  await robinRow.getByRole("link", { name: "Open general" }).click();
  await expect(robin.getByRole("region", { name: "#general" })).toBeVisible();

  // ── A message, and the other person sees it ─────────────────────────────────────────────────
  const composer = page.getByRole("textbox", { name: "Say something in #general" });
  await composer.fill("morning all");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages in #general" });
  await expect(flow.getByTestId("message").filter({ hasText: "morning all" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    robin.getByRole("log", { name: "Messages in #general" }).getByTestId("message"),
  ).toContainText(["morning all"], { timeout: 30_000 });

  // ── A mention, picked from the list the composer offers ─────────────────────────────────────
  await composer.click();
  await page.keyboard.type("over to you @rob");
  const mentions = page.getByRole("listbox", { name: "Mentions" });
  await expect(mentions).toBeVisible();
  await expect(mentions.getByRole("option")).toContainText(["Robin"]);
  await page.keyboard.press("Enter");
  // The handle comes from the email a test account signed up with, so it is `robin-<stamp>`.
  await expect(composer).toHaveValue(/over to you <@robin-[0-9-]+> $/);
  await composer.press("Enter");
  // It arrives as a mention, not as the token that was typed.
  const mentioned = flow.getByTestId("message").filter({ hasText: "over to you" });
  await expect(mentioned.getByTestId("mention")).toContainText("@robin", { timeout: 30_000 });

  // ── A thread, with its reply count ──────────────────────────────────────────────────────────
  const first = flow.getByTestId("message").filter({ hasText: "morning all" });
  await first.getByRole("button", { name: "Reply" }).click();
  const thread = page.getByTestId("thread");
  await expect(thread).toBeVisible();
  const threadBox = page.getByRole("textbox", { name: "Reply in this thread" });
  await threadBox.fill("morning");
  await threadBox.press("Enter");
  await expect(thread.getByTestId("message")).toContainText(["morning all", "morning"], {
    timeout: 30_000,
  });
  await expect(first.getByTestId("reply-count")).toHaveText("1 replies", { timeout: 30_000 });
  await page.getByRole("button", { name: "Close thread" }).click();

  // ── The hover toolbar: pin, and save for later ──────────────────────────────────────────────
  await first.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(first.getByText("Pinned")).toBeVisible({ timeout: 30_000 });
  await first.getByRole("button", { name: "Save for later" }).click();
  await expect(first.getByText("Saved")).toBeVisible({ timeout: 30_000 });
  // A pin is the channel's, so the other person sees it too; a save is one person's own.
  const robinFirst = robin
    .getByRole("log", { name: "Messages in #general" })
    .getByTestId("message")
    .filter({ hasText: "morning all" });
  await expect(robinFirst.getByText("Pinned")).toBeVisible({ timeout: 30_000 });
  await expect(robinFirst.getByText("Saved")).toBeHidden();

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // ── An edit, and what it said before ────────────────────────────────────────────────────────
  await first.getByRole("button", { name: "Edit" }).click();
  const editForm = page.getByRole("form", { name: "Edit message" });
  await editForm.getByLabel("Edit message").fill("morning all, and welcome");
  await editForm.getByRole("button", { name: "Save" }).click();
  await expect(
    flow.getByTestId("message").filter({ hasText: "morning all, and welcome" }),
  ).toBeVisible({ timeout: 30_000 });
  await flow
    .getByTestId("message")
    .filter({ hasText: "and welcome" })
    .getByRole("button", { name: "(edited)" })
    .click();
  const history = page.getByRole("list", { name: "Edit history" });
  await expect(history.getByTestId("edit")).toContainText(["morning all"]);
  await page.getByRole("button", { name: "Close history" }).click();

  // ── A delete leaves a hole, not a lie ───────────────────────────────────────────────────────
  const mine = flow.getByTestId("message").filter({ hasText: "over to you" });
  await mine.getByRole("button", { name: "Delete" }).click();
  await expect(flow.getByText("This message was deleted.")).toBeVisible({ timeout: 30_000 });

  // ── Read state: Robin's unread goes back to nothing once they have read it ──────────────────
  await robin.goto(`/${slug}/home`);
  const robinChannelRow = robin.getByTestId("channel-row").filter({ hasText: "general" });
  await expect(robinChannelRow).toBeVisible();
  await robinChannelRow.getByRole("link", { name: "Open general" }).click();
  await expect(robin.getByRole("region", { name: "#general" })).toBeVisible();
  // Back on Home, the sidebar carries no unread badge for a channel that has been read.
  await robin.goto(`/${slug}/home`);
  if (mobile) await robin.getByRole("button", { name: "Toggle sidebar" }).click();
  const link = robin.getByRole("link", { name: "#general" });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).not.toContainText(/[0-9]/, { timeout: 30_000 });

  await page.goto(channelUrl);
  await robin.context().close();
});
