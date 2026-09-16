import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

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

/**
 * Task 3.26 (spec §4): the rest of Work mode. The acceptance is the two clauses of the task — a
 * cycle closes with its burndown, and a view somebody saved is the view they get back — with the
 * layouts, the panel and the sidebar around them, because that is where a person meets all three.
 */
test("a cycle, a saved view, and the five layouts", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  // The sidebar is a sheet on a phone, and cycles live in it (spec §4).
  const openSidebar = async () => {
    if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  };
  // The sheet closes with Escape, which is how the rest of the suite puts one away.
  const closeSheet = async () => {
    if (mobile) await page.keyboard.press("Escape");
  };
  await signUp(page, "Cycle Owner", uniqueEmail("cycle"));
  const slug = await createWorkspace(page, "Cycle Nest");

  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("The Feeder");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project-row").filter({ hasText: "The Feeder" })).toBeVisible();

  await page.goto(`/${slug}/work`);
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();

  // Three items, two of them urgent, so a view has something to be about.
  for (const title of ["Clean the feeder", "Refill the feeder", "Paint the feeder"]) {
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Add an item" }).click();
    await expect(page.getByRole("article").filter({ hasText: title })).toBeVisible();
  }

  // A cycle, made from the sidebar, which is where §4 puts them.
  await openSidebar();
  await page.getByLabel("Cycle name").fill("Cycle 12");
  await page.getByRole("button", { name: "Add a cycle" }).click();
  const cycle = page.getByRole("button", { name: /^Cycle 12/ });
  await expect(cycle).toBeVisible();
  await closeSheet();

  // Put one item in it, from the panel: the panel is where an item's properties live.
  await page.getByRole("button", { name: "Open THE-FEEDER-1" }).click();
  const panel = page.getByTestId("work-item-panel");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Cycle").selectOption({ label: "Cycle 12" });
  // The description is a document, loaded with the panel and not before it.
  await expect(panel.getByRole("textbox", { name: "Description" })).toBeVisible();
  await panel.getByRole("textbox", { name: "Description" }).fill("Scrub it, then rinse.");
  await panel.getByRole("button", { name: "Save the description" }).click();
  await expect(panel.getByRole("status").getByText("Saved")).toBeVisible();

  // Finish it, so the burndown has something to burn down.
  await panel.getByLabel("State").selectOption("done");
  await page.getByRole("button", { name: "Close the panel" }).click();

  // The cycle's burndown, and closing it carries the rest over rather than finishing it.
  await openSidebar();
  await cycle.click();
  await closeSheet();
  const burndown = page.getByTestId("work-burndown");
  await expect(burndown).toBeVisible();
  await expect(burndown).toContainText("1 of 1 done");
  await burndown.getByRole("button", { name: "Close this cycle" }).click();
  await expect(page.getByTestId("work-cycle-closed")).toContainText("carried over");
  await openSidebar();
  await expect(page.getByRole("button", { name: /^Cycle 12 · Closed/ })).toBeVisible();
  await closeSheet();

  // The five layouts of §4. Each one draws the same rows its own way.
  await openSidebar();
  await page.getByRole("button", { name: /^Cycle 12 · Closed/ }).click(); // back to everything
  await closeSheet();
  await page.getByTestId("work-layout").selectOption("list");
  await expect(page.getByTestId("work-row").first()).toBeVisible();
  await page.getByTestId("work-layout").selectOption("spreadsheet");
  await expect(page.getByRole("columnheader", { name: "Title" })).toBeVisible();
  await page.getByTestId("work-layout").selectOption("calendar");
  await expect(page.getByRole("status")).toBeVisible();
  await page.getByTestId("work-layout").selectOption("timeline");
  await expect(page.getByRole("status")).toBeVisible();

  // A view somebody saved is the view they get back: save the list layout, open something else,
  // come back to it, and reload the page for good measure.
  await page.getByTestId("work-layout").selectOption("list");
  await page.getByLabel("View name").fill("My list");
  await page.getByRole("button", { name: "Save this view" }).click();
  await expect(page.getByRole("status").getByText("Saved “My list”")).toBeVisible();

  await page.getByTestId("work-layout").selectOption("board");
  await expect(page.getByRole("region", { name: /^Backlog, / })).toBeVisible();

  await page.getByTestId("work-view").selectOption({ label: "My list" });
  await expect(page.getByTestId("work-layout")).toHaveValue("list");
  await expect(page.getByTestId("work-row").first()).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("work-view")).toHaveValue(/.+/);
  await expect(page.getByTestId("work-layout")).toHaveValue("list");
  await expect(page.getByTestId("work-row").first()).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
});
