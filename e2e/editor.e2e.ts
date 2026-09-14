import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.6 (spec §5.1): open a project in Code mode, browse its file tree, edit a TypeScript file
 * in CodeMirror, save it, reload and reopen it (the change persisted on the runner), preview a
 * markdown file and an image, search the project; axe clean at both viewports. The project is
 * uploaded through the UI so the spec needs no network.
 */

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("open, edit, save, and reopen a file; preview markdown and images", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  const email = uniqueEmail("editor");
  await signUp(page, "Editor Owner", email);
  const slug = await createWorkspace(page, "Editor Nest");
  await page.goto(`/${slug}/code`);

  // An upload project with three files.
  await page.getByLabel("Project name").fill("Notes");
  await page.getByRole("radio", { name: "Upload files" }).check();
  await page.getByLabel("Files", { exact: true }).setInputFiles([
    {
      name: "README.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes\n\nHello **world**.\n"),
    },
    {
      name: "app.ts",
      mimeType: "text/typescript",
      buffer: Buffer.from("export const answer = 42;\n"),
    },
    { name: "logo.png", mimeType: "image/png", buffer: PNG },
  ]);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Uploaded 3 files." })).toBeVisible({
    timeout: 60_000,
  });
  const row = page.getByTestId("project-row").filter({ hasText: "Notes" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready");

  // Into the editor.
  await page.getByRole("link", { name: "Open Notes" }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/code/notes$`));
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  await expect(page.getByText("No file open")).toBeVisible();

  const openFromTree = async (name: string) => {
    if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
    const tree = page.getByRole("tree", { name: "Files" });
    await expect(tree).toBeVisible();
    await tree.getByRole("treeitem", { name }).click();
  };

  // Markdown: preview by default, source on request.
  await openFromTree("README.md");
  const preview = page.getByTestId("markdown-preview");
  await expect(preview.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  await expect(preview.locator("strong")).toHaveText("world");
  // The toggle lives in the breadcrumb bar (the sidebar has a "Previews" section of its own).
  const crumbs = page.getByRole("navigation", { name: "Breadcrumbs" }).locator("..");
  await crumbs.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByTestId("code-editor")).toContainText("# Notes");
  await crumbs.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(preview).toBeVisible();

  // TypeScript: edit, save with the button, and the tab loses its dirty mark.
  await openFromTree("app.ts");
  const tabs = page.getByRole("tablist", { name: "Open files" });
  await expect(tabs.getByRole("tab", { name: /app\.ts/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("navigation", { name: "Breadcrumbs" })).toContainText("app.ts");
  const editor = page.getByTestId("code-editor");
  await expect(editor).toContainText("answer = 42");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("export const more = 1;");
  await expect(tabs.getByRole("tab", { name: /app\.ts/ })).toContainText("unsaved changes");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("editor-notice")).toHaveText("Saved");
  await expect(tabs.getByRole("tab", { name: /app\.ts/ })).not.toContainText("unsaved changes");

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // Reload: the tabs are gone, the file on the runner keeps the edit.
  await page.reload();
  await expect(page.getByText("No file open")).toBeVisible();
  await openFromTree("app.ts");
  await expect(page.getByTestId("code-editor")).toContainText("more = 1");

  // An image previews; search finds the file and opens it at its line.
  await openFromTree("logo.png");
  await expect(page.getByTestId("image-preview")).toBeVisible();
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByLabel("Search files").fill("answer");
  const hit = page.getByTestId("file-search-results").getByRole("button", { name: /app\.ts/ });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(tabs.getByRole("tab", { name: /app\.ts/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("code-editor")).toContainText("answer = 42");

  // Keyboard on the tab strip: Delete closes the focused tab.
  await tabs.getByRole("tab", { name: /app\.ts/ }).focus();
  await page.keyboard.press("Delete");
  await expect(tabs.getByRole("tab", { name: /app\.ts/ })).toHaveCount(0);
  test.info().annotations.push({ type: "project", description: info.project.name });
});
