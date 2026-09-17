import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.20 (spec §4 drawer, §5.1): the Git panel. Edit a file in the editor, open the drawer's
 * Git tab, have the agent write the commit message, commit it, and watch the panel go quiet — then
 * branch from there.
 *
 * Push and Open PR need a provider; they are covered end to end against a stand-in GitHub in
 * apps/api/test/connections.test.ts, and through this panel in phase1.e2e.ts.
 *
 * "Write it for me" has no engine picker either, so it runs on the project's default engine — see
 * the note in inline-edit.e2e.ts.
 */

test("write a file, let the agent name the commit, commit it, and branch", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("git");
  await signUp(page, "Git Owner", email);
  const slug = await createWorkspace(page, "Git Nest");

  const mobile = info.project.name === "mobile";
  await page.goto(`/${slug}/code`);

  // A project with one file, so there is something to change.
  await page.getByLabel("Project name").fill("Repo");
  await page.getByRole("radio", { name: "Upload files" }).check();
  await page
    .getByLabel("Files", { exact: true })
    .setInputFiles([
      { name: "app.ts", mimeType: "text/typescript", buffer: Buffer.from("export const a = 1;\n") },
    ]);
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Repo" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 90_000 });
  await page.getByRole("link", { name: "Open Repo" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Repo" })).toBeVisible();

  // Edit it in the editor and save, the way anybody would.
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "app.ts" }).click();
  const editor = page.getByTestId("code-editor");
  await expect(editor).toContainText("export const a = 1;", { timeout: 20_000 });
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("export const b = 2;");
  await page.getByRole("button", { name: "Save" }).click();
  // Saving is a round trip through the project's runner, and the notice clears itself two
  // seconds later; five is not enough of a window on a loaded machine.
  await expect(page.getByTestId("editor-notice")).toHaveText("Saved", { timeout: 30_000 });

  // The drawer's Git tab: the change is listed.
  await page.getByRole("button", { name: "Toggle drawer" }).click();
  await page.getByRole("tab", { name: "Git" }).click();
  const git = page.getByRole("region", { name: "Git" });
  await expect(git).toBeVisible();
  await expect(git.getByRole("list", { name: "Changes" })).toContainText("app.ts", {
    timeout: 20_000,
  });

  // The agent writes the message, and it lands in the box.
  await git.getByRole("button", { name: "Write it for me" }).click();
  const message = git.getByRole("textbox", { name: "Commit message" });
  await expect(message).toHaveValue(/app/, { timeout: 60_000 });

  // Commit: the panel says which commit, and there is nothing left to say.
  await git.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(git.getByTestId("git-note")).toContainText("Committed", { timeout: 30_000 });
  await expect(git.getByText("Nothing to commit.")).toBeVisible({ timeout: 30_000 });

  // A branch, from the panel.
  await git.getByLabel("New branch", { exact: true }).fill("perch/from-the-panel");
  await git.getByRole("button", { name: "Create" }).click();
  await expect(git.getByLabel("Branch", { exact: true })).toHaveValue("perch/from-the-panel", {
    timeout: 30_000,
  });

  if (info.project.name !== "mobile") {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }
});
