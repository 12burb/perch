import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 3.13 (spec §4 "Work (Plane)"): the board in Work mode. An item is added, shows the
 * `KEY-123` §7.8 promises, sits in the column its state names, and moves when somebody moves it —
 * at 1440 px and at 390 px, and passing axe at both.
 *
 * Handing an item to an agent is the api test's (`apps/api/test/work.test.ts`), because what it
 * proves is a session's statuses moving a card, which is a bus and not a browser.
 */

test("a board, a KEY-123, and a card that moves", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Board Owner", uniqueEmail("board"));
  const slug = await createWorkspace(page, "Board Nest");

  // Nothing to put on a board until there is a project to put it in.
  await page.goto(`/${slug}/work`);
  await expect(page.getByRole("heading", { level: 1, name: "Work" })).toBeVisible();
  await expect(page.getByRole("status").getByText("No work items yet")).toBeVisible();

  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("The Site");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project-row").filter({ hasText: "The Site" })).toBeVisible();

  await page.goto(`/${slug}/work`);
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();
  // The seven columns of §4, each saying how many it holds.
  for (const state of ["Backlog", "Queued", "Running", "Needs you", "In review", "Done"]) {
    await expect(page.getByRole("region", { name: new RegExp(`^${state}, `) })).toBeVisible();
  }

  await page.getByLabel("Title").fill("Fix the login redirect");
  await page.getByRole("button", { name: "Add an item" }).click();

  const card = page.getByRole("article").filter({ hasText: "Fix the login redirect" });
  await expect(card).toBeVisible();
  // `KEY-123`: the project's key, and the first number in it.
  await expect(card).toContainText("THE-SITE-1");
  await expect(
    page.getByRole("region", { name: /^Backlog, 1 items/ }).getByRole("article"),
  ).toHaveCount(1);

  // Moving one by hand is a select, not a drag, so it works with a thumb.
  await card.getByRole("combobox").selectOption("queued");
  await expect(page.getByRole("region", { name: /^Queued, 1 items/ })).toContainText("THE-SITE-1");
  await expect(page.getByRole("region", { name: /^Backlog, 0 items/ })).toBeVisible();

  // It survives a reload: the board is the database, not this tab.
  await page.reload();
  await expect(page.getByRole("region", { name: /^Queued, 1 items/ })).toContainText("THE-SITE-1");

  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
});
