import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 4.5 (spec §6, §7.1): the audit page shows who did what and when, narrows to the question
 * being asked, and lets somebody take the answer away as a CSV.
 */

test("the audit page says who did what and when, filters, and exports", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Auditor", uniqueEmail("audit"));
  const slug = await createWorkspace(page, "Watched Nest");

  // Do a few things worth recording, then look at the record.
  await page.goto(`/${slug}/settings`);
  const general = page.getByRole("region", { name: "General" });
  await general.getByLabel("Name").fill("Watched Nest, renamed");
  await general.getByRole("button", { name: "Save" }).click();
  await expect(general.getByRole("status")).toBeVisible();

  await page.reload();
  const audit = page.getByRole("region", { name: "Audit log" });
  await expect(audit).toBeVisible();
  const rows = audit.getByTestId("audit-row");
  await expect(rows.first()).toBeVisible();
  await expect(audit.getByTestId("audit-table")).toContainText("workspace.updated");
  // Every row says who did it; here that is the only person in the workspace.
  await expect(rows.first()).toContainText("Person");

  // Narrowed to one kind of thing: what is left is only that.
  await audit.getByTestId("audit-action").selectOption("workspace.updated");
  await expect(rows.first()).toContainText("workspace.updated");
  await expect(rows).toHaveCount(1);

  // A filter that matches nothing says so rather than quietly showing everything.
  await audit.getByTestId("audit-actor").selectOption("bot");
  await expect(audit.getByText("No audit rows yet")).toBeVisible();
  await audit.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows.first()).toBeVisible();

  // The export carries the filter it was taken with, and downloads as a CSV.
  const link = audit.getByTestId("audit-export");
  expect(await link.getAttribute("href")).toContain("/audit/export");
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^perch-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await download.path()) ?? "", "utf8");
  expect(text.split("\n")[0]).toContain("actor_type,actor_id,action");
  expect(text).toContain("workspace.updated");

  // Owning a workspace says nothing about the instance, so retention is not this person's to set.
  await expect(audit.getByTestId("audit-retention")).toHaveCount(0);

  const axe = await new AxeBuilder({ page }).include('[aria-labelledby="audit-heading"]').analyze();
  expect(axe.violations).toEqual([]);
});

test("how long the log is kept is the instance admin's to say", async ({ page }) => {
  test.setTimeout(120_000);
  // The account this instance was set up with, and its workspace (scripts/e2e-server.ts).
  await page.goto("/sign-in");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill("admin@perch.test");
  await page.getByLabel("Password").fill("admin-passphrase-for-tests");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Leaving the sign-in page is the signal; where it lands afterwards depends on what this
  // account already has, and this test does not care.
  await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 30_000 });

  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/admin\/settings/);
  const audit = page.getByRole("region", { name: "Audit log" });
  await expect(audit).toBeVisible();
  const days = audit.getByTestId("audit-retention");
  await expect(days).toBeVisible();
  await days.fill("30");
  await audit.getByRole("button", { name: "Save" }).click();
  await expect(audit.getByTestId("audit-retention-hint")).toContainText("30 days");

  // And back to forever, so the rest of the suite is not pruned out from under it.
  await days.fill("0");
  await audit.getByRole("button", { name: "Save" }).click();
  await expect(audit.getByTestId("audit-retention-hint")).toContainText("Kept forever");
});
