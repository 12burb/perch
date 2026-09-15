import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.14 (spec §4 "⌘K inline edit on a selection with the diff in place"): a selection in the
 * editor, an instruction, the agent's rewrite in the buffer with the replaced lines struck through
 * above it, Accept keeps it and Save writes it; Reject puts the original back. ⌘K with a selection
 * belongs to the editor, so the command palette stays shut.
 */

test("select, instruct, diff in place, accept — and reject puts it back", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Inline Owner", uniqueEmail("inline"));
  const slug = await createWorkspace(page, "Inline Nest");
  await page.goto(`/${slug}/code`);

  await page.getByLabel("Project name").fill("Sketch");
  await page.getByRole("radio", { name: "Upload files" }).check();
  await page.getByLabel("Files", { exact: true }).setInputFiles([
    {
      name: "app.ts",
      mimeType: "text/typescript",
      buffer: Buffer.from("const one = 1;\nconst two = 2;\nconst three = 3;\n"),
    },
  ]);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Uploaded 1 file" })).toBeVisible({
    timeout: 60_000,
  });
  const row = page.getByTestId("project-row").filter({ hasText: "Sketch" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open Sketch" }).click();

  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const tree = page.getByRole("tree", { name: "Files" });
  await tree.getByRole("treeitem", { name: "app.ts" }).click();
  const editor = page.getByTestId("code-editor");
  await expect(editor.locator(".cm-content")).toContainText("const one = 1;");

  // Select the first line and ask for the edit: ⌘K here is the editor's, not the palette's.
  const selectFirstLine = async () => {
    await editor.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Shift+ArrowDown");
  };
  await selectFirstLine();
  await page.keyboard.press("Control+k");
  const bar = page.getByTestId("inline-edit");
  await expect(bar).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);

  const instruction = bar.getByRole("textbox", { name: "Instruction" });
  await expect(instruction).toBeFocused();
  await instruction.fill("uppercase it");
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);
  await instruction.press("Enter");

  // The proposal lands in the buffer with the replaced line struck through above it.
  await expect(page.getByTestId("inline-removed")).toHaveText("const one = 1;\n", {
    timeout: 60_000,
  });
  await expect(editor.locator(".cm-content")).toContainText("CONST ONE = 1;");
  await expect(editor.locator(".cm-perch-added")).toBeVisible();

  // Accept keeps it, and it is the buffer that Save writes.
  await bar.getByRole("button", { name: "Accept edit" }).click();
  await expect(bar).toBeHidden();
  await expect(page.getByTestId("inline-removed")).toHaveCount(0);
  await expect(editor.locator(".cm-content")).toContainText("CONST ONE = 1;");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("editor-notice")).toHaveText("Saved");

  // Reject puts the original line back and leaves nothing behind.
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Control+k");
  await bar.getByRole("textbox", { name: "Instruction" }).fill("comment it out");
  await bar.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(editor.locator(".cm-content")).toContainText("// const two = 2;", {
    timeout: 60_000,
  });
  await bar.getByRole("button", { name: "Reject edit" }).click();
  await expect(bar).toBeHidden();
  await expect(editor.locator(".cm-content")).toContainText("const two = 2;");
  await expect(editor.locator(".cm-content")).not.toContainText("// const two = 2;");
  await expect(page.getByTestId("inline-removed")).toHaveCount(0);

  // Without a selection, ⌘K is still the command palette.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});
