import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.13 (spec §4 "editor and review", §5.1): the Changes view of a session. Two turns on the
 * laptop runner's fake ACP agent write a file and then edit three far-apart lines; the turn's diff
 * is three labelled hunks. Two are accepted and one rejected (its lines go back out of the file on
 * the runner); a code block in a reply is applied to the file it names; restoring turn 1 puts the
 * project back to before the session touched it. Axe clean at both viewports.
 */

test("accept two hunks, reject one, apply a code block, restore turn 1", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Diff Owner", uniqueEmail("diff"));
  const slug = await createWorkspace(page, "Diff Nest");
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Review");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Review" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open Review" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review" })).toBeVisible();

  const openSidebar = async () => {
    if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  };
  await openSidebar();
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.getByRole("form", { name: "Start a session" });
  await form.getByLabel("Engine").selectOption("acp");
  await form.getByRole("button", { name: "Start" }).click();

  const pane = page.getByTestId("session-pane");
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const log = pane.getByRole("log", { name: "Transcript" });
  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  const send = async (text: string, reply: string) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(log.getByTestId("transcript-text").last()).toContainText(reply, {
      timeout: 60_000,
    });
    await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 30_000 });
  };

  // Turn 1 writes the file; turn 2 edits three lines far enough apart to be three hunks.
  await send("seed", "Seeded notes.txt with 30 lines.");
  await send("spread", "Edited lines 2, 15, and 28.");

  // The Changes view: the second turn's diff, from its checkpoint to the tree as it is now.
  await pane.getByRole("tab", { name: "Changes" }).click();
  const changes = pane.getByRole("region", { name: "Changes" });
  await pane.getByLabel("Diff scope").selectOption("2");
  await expect(changes.getByRole("heading", { level: 3 })).toHaveText(["notes.txt"]);
  await expect(changes.getByRole("heading", { level: 4 })).toHaveCount(3);
  await expect(changes.getByRole("heading", { level: 4 }).first()).toContainText("Hunk 1 of 3");
  await expect(changes).toContainText("line 28 (edited)");
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // Accept two hunks (a review decision), reject the third (taken back out on the runner).
  await changes.getByRole("button", { name: "Accept hunk 1 of notes.txt" }).click();
  await changes.getByRole("button", { name: "Accept hunk 2 of notes.txt" }).click();
  await expect(changes.getByTestId("diff-hunk").first()).toContainText("Accepted");
  await changes.getByRole("button", { name: "Reject hunk 3 of notes.txt" }).click();
  await expect(changes.getByRole("heading", { level: 4 })).toHaveCount(2);
  await expect(changes).not.toContainText("line 28 (edited)");
  await expect(changes).toContainText("line 2 (edited)");
  await expect(changes.getByTestId("diff-hunk").last()).toContainText("Accepted");

  // The diff opens the file in the editor beside it (the pane covers main on a phone).
  if (!mobile) {
    await changes.getByRole("button", { name: "Open notes.txt" }).click();
    await expect(page.getByTestId("code-editor")).toContainText("line 15 (edited)", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("code-editor")).not.toContainText("line 28 (edited)");
  }

  // A code block in a reply applies to the file its fence names, and shows up in the diff.
  await pane.getByRole("tab", { name: "Transcript" }).click();
  await send("snippet", "Here is a note to apply:");
  await log
    .getByTestId("code-block")
    .last()
    .getByRole("button", { name: "Apply code block to snippet.txt" })
    .click();
  await expect(pane).toContainText("Applied to snippet.txt");
  await expect(changes.getByRole("heading", { level: 3 })).toHaveText(
    ["notes.txt", "snippet.txt"],
    { timeout: 20_000 },
  );
  await expect(changes).toContainText("hello from a code block");

  // Restoring turn 1 puts the project back to before the session ran.
  await pane.getByRole("tab", { name: "Transcript" }).click();
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  await log.getByRole("button", { name: "Restore to before turn 1" }).click();
  // On a phone the pane is itself a sheet, so the confirmation is named, not just "the dialog".
  const dialog = page.getByRole("dialog", { name: "Restore to before turn 1?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(dialog).toBeHidden();
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(log.getByTestId("transcript-restore")).toHaveText("Restored to before turn 1");
  await pane.getByRole("tab", { name: "Changes" }).click();
  await expect(changes).toContainText("No changes.", { timeout: 20_000 });
});
