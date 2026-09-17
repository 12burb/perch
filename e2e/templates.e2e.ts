import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 4.8 (spec §10's Phase 4 line "one-click templates, starter stacks and a demo workspace").
 *
 * The acceptance in one walk: pick a starter stack, name it, press Create — and the project comes
 * up with the stack's files and the stack's own `.perch/project.json` already read, so the Preview
 * tab knows both the command and the port. One press of Start and the dev server is serving the
 * stack's page through Perch.
 *
 * The Bun API stack is the one used here because it installs nothing: a template that needs a
 * package registry is a template that cannot be proved offline.
 */

test("a starter stack becomes a project with its preview running", async ({ page }) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("template");
  await signUp(page, "Template Owner", email);
  const slug = await createWorkspace(page, "Template Nest");

  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Birdsong");
  await page.getByRole("radio", { name: "Start from a template" }).check();
  const picker = page.getByLabel("Template", { exact: true });
  await expect(picker).toBeVisible();
  // The catalogue is the one the api serves, and the stacks say what they are.
  await expect(picker.locator("option")).toContainText([/Choose/, /Bun API/]);
  await picker.selectOption("bun-api");
  await page.getByRole("button", { name: "Create project" }).click();

  const row = page.getByTestId("project-row").filter({ hasText: "Birdsong" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 120_000 });
  await page.getByRole("link", { name: "Birdsong" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Birdsong" })).toBeVisible();

  // The Preview tab knows what to run and where, because the stack said so in its own config.
  await page.goto(`/${slug}/code/birdsong?view=preview`);
  const preview = page.getByRole("region", { name: "Preview", exact: true });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  // Nothing is on the port yet, and the pane says what would put something there.
  await expect(preview.getByRole("button", { name: "Start", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(preview).toContainText("bun --hot src/index.ts", { timeout: 30_000 });

  const scan = await new AxeBuilder({ page }).include("main").exclude("iframe").analyze();
  expect(scan.violations).toEqual([]);

  // One press, and the dev server is up and being served through Perch: the pane stops being an
  // empty state and the stack's own page is in the frame.
  await preview.getByRole("button", { name: "Start", exact: true }).click();
  await expect(preview.locator("iframe")).toBeVisible({ timeout: 150_000 });
  await expect(page.frameLocator("iframe").locator("#app")).toHaveText("Bun API", {
    timeout: 60_000,
  });

  // And Stop takes it down again, from the toolbar where it is running.
  await preview.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(preview.getByRole("button", { name: "Start", exact: true })).toBeVisible({
    timeout: 60_000,
  });
});
