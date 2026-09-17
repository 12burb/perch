import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.14 (spec §4 "⌘K inline edit on a selection with the diff in place"): a selection in the
 * editor, an instruction, the agent's rewrite in the buffer with the replaced lines struck through
 * above it, Accept keeps it and Save writes it; Reject puts the original back. Leaving the file
 * with a proposal unanswered puts the original back too, because nothing else can: the buffer is
 * already the agent's text (ADR-0080 §5). ⌘K with a selection belongs to the editor, so the
 * command palette stays shut.
 *
 * ⌘K has no engine picker, so the round runs on the project's default engine — `opencode` for a
 * project that ships no .perch/project.json, which the harness has a stand-in server for
 * (ADR-0089). What it answers is a stand-in's answer either way; this spec is about the editor.
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
    { name: "other.ts", mimeType: "text/typescript", buffer: Buffer.from("const far = 9;\n") },
  ]);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Uploaded 2 files" })).toBeVisible({
    timeout: 60_000,
  });
  const row = page.getByTestId("project-row").filter({ hasText: "Sketch" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open Sketch" }).click();

  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const tree = page.getByRole("tree", { name: "Files" });
  const editor = page.getByTestId("code-editor");
  // Both files open, so the tab strip can switch between them later without the tree, which is a
  // sheet on a phone.
  await tree.getByRole("treeitem", { name: "other.ts" }).click();
  await expect(editor.locator(".cm-content")).toContainText("const far = 9;");
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await tree.getByRole("treeitem", { name: "app.ts" }).click();
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
  // Saving is a round trip through the project's runner, and the notice clears itself two
  // seconds later; five is not enough of a window on a loaded machine.
  await expect(page.getByTestId("editor-notice")).toHaveText("Saved", { timeout: 30_000 });

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

  // Leaving the file with a proposal standing puts the original back: the agent's text is already
  // in the buffer, so dropping only the bar would strand it there unreviewable (ADR-0080 §5).
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Control+k");
  await bar.getByRole("textbox", { name: "Instruction" }).fill("uppercase it");
  await bar.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(editor.locator(".cm-content")).toContainText("CONST THREE = 3;", {
    timeout: 60_000,
  });
  await page.getByRole("tab", { name: "other.ts" }).click();
  await expect(editor.locator(".cm-content")).toContainText("const far = 9;");
  await expect(bar).toBeHidden();
  await page.getByRole("tab", { name: "app.ts" }).click();
  await expect(editor.locator(".cm-content")).toContainText("const three = 3;");
  await expect(editor.locator(".cm-content")).not.toContainText("CONST THREE = 3;");
  await expect(page.getByTestId("inline-removed")).toHaveCount(0);
  // Nothing unsaved is left behind either: the original is back, so Save has nothing to write.
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

  // Asking again while a proposal stands puts that one back first: one proposal at a time, or its
  // original would be lost and Cancel would revert the wrong range.
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Control+k");
  await bar.getByRole("textbox", { name: "Instruction" }).fill("uppercase it");
  await bar.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(editor.locator(".cm-content")).toContainText("CONST TWO = 2;", { timeout: 60_000 });
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Control+k");
  await expect(bar.getByRole("textbox", { name: "Instruction" })).toBeVisible();
  await expect(editor.locator(".cm-content")).toContainText("const two = 2;");
  await expect(editor.locator(".cm-content")).not.toContainText("CONST TWO = 2;");
  await expect(page.getByTestId("inline-removed")).toHaveCount(0);
  await bar.getByRole("textbox", { name: "Instruction" }).press("Escape");
  await expect(bar).toBeHidden();

  // Without a selection, ⌘K is still the command palette.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});
