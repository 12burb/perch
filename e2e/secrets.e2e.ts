import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.12 (spec §5.7 "secret scanning on every agent diff before commit"). The acceptance: a
 * planted key blocks the commit with a card. Taking it out lets the same commit through, which is
 * the other half of the promise — the gate has to be one a person can get past honestly.
 */

// A shape, not a secret: 20 characters that match what AWS stamps on an access key id.
const PLANTED = `AKIA${"IOSFODNN7QQWERTY"}`;

test("a planted key blocks the commit with a card, and taking it out lets it through", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Robin", uniqueEmail("secrets"));
  const slug = await createWorkspace(page, "Secrets Nest");

  await page.goto(`/${slug}/code`);
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

  // What an agent's edit looks like from here: a key written into a file and saved.
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "app.ts" }).click();
  const editor = page.getByTestId("code-editor");
  await expect(editor).toContainText("export const a = 1;", { timeout: 20_000 });
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`export const key = "${PLANTED}";`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("editor-notice")).toHaveText("Saved");

  // The commit is stopped, and the panel says what is in the way and where.
  await page.getByRole("button", { name: "Toggle drawer" }).click();
  await page.getByRole("tab", { name: "Git" }).click();
  const git = page.getByRole("region", { name: "Git" });
  await expect(git.getByRole("list", { name: "Changes" })).toContainText("app.ts", {
    timeout: 20_000,
  });
  await git.getByRole("textbox", { name: "Commit message" }).fill("feat: add the key");
  await git.getByRole("button", { name: "Commit", exact: true }).click();
  const card = page.getByTestId("secrets-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("an AWS access key id");
  await expect(card).toContainText("app.ts");
  // The card shows enough to find it and not enough to use it.
  await expect(card).not.toContainText(PLANTED);
  // And nothing was committed: the change is still there.
  await expect(git.getByRole("list", { name: "Changes" })).toContainText("app.ts");

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // Take it out, and the same commit goes through.
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("export const key = process.env.AWS_KEY;");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("editor-notice")).toHaveText("Saved");
  await git.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(git.getByTestId("git-note")).toContainText("Committed", { timeout: 30_000 });
  await expect(page.getByTestId("secrets-card")).toHaveCount(0);
});
