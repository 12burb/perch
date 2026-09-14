import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { createWorkspace, isMobile, openAccountMenu, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 0.12 acceptance (spec §4, §11): the shell with the six rail tabs (or the mobile tab bar), empty
 * states that suggest the next action, profile and workspace settings; every page passes axe; and the
 * 390 px / 1440 px screenshots under docs/screenshots/0.12 when E2E_SCREENSHOTS=1.
 */

const SCREENSHOTS = process.env.E2E_SCREENSHOTS === "1";

async function checkPage(page: Page, name: string, project: string): Promise<void> {
  // A theme switch animates colors (transition-colors): axe must not sample a blend of two themes.
  await page.evaluate(
    "Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))",
  );
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    `${name}: ${JSON.stringify(results.violations.map((v) => v.id))}`,
  ).toEqual([]);
  if (SCREENSHOTS) {
    await page.screenshot({
      path: `docs/screenshots/0.12/${project}-${name}.png`,
      fullPage: false,
    });
  }
}

test("the six modes, the settings pages, and their empty states", async ({ page }, info) => {
  const mobile = isMobile(info.project.name);
  const project = info.project.name;
  await signUp(page, "Dawn Bird", uniqueEmail("dawn"));
  await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
  await checkPage(page, "welcome", project);
  const slug = await createWorkspace(page, "The Nest");

  const modes = [
    { mode: "home", title: "Home", empty: "No channels yet" },
    { mode: "code", title: "Code", empty: "No projects yet" },
    { mode: "work", title: "Work", empty: "No work items yet" },
    { mode: "bots", title: "Bots", empty: "No bots yet" },
    { mode: "inbox", title: "Inbox", empty: "Nothing needs you" },
    { mode: "search", title: "Search", empty: "Search everything" },
  ] as const;

  for (const { mode, title, empty } of modes) {
    if (mobile) {
      await page.goto(`/${slug}/${mode}`);
    } else {
      await page.getByRole("tablist", { name: "Modes" }).getByRole("tab", { name: title }).click();
      await expect(
        page.getByRole("tablist", { name: "Modes" }).getByRole("tab", { name: title }),
      ).toHaveAttribute("aria-selected", "true");
    }
    await expect(page).toHaveURL(new RegExp(`/${slug}/${mode}$`));
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("status")).toContainText(empty);
    await expect(page.getByRole("main")).toBeVisible();
    if (!mobile) {
      await expect(page.getByRole("complementary", { name: title })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Modes" })).toBeVisible();
    } else {
      await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
    }
    await checkPage(page, mode, project);
  }

  if (mobile) {
    // The tab bar navigates, and More holds the rest.
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Work" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/${slug}/work$`));
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "More" })
      .click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Bots" }).click();
    await expect(page).toHaveURL(new RegExp(`/${slug}/bots$`));
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "More" })
      .click();
    await checkPage(page, "more", project);
    await page.keyboard.press("Escape");
  } else {
    // ⌘K opens the palette and navigates.
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("go to inbox");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${slug}/inbox$`));
    // ⌘B hides the sidebar and the state survives a reload of the same mode.
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByRole("complementary", { name: "Inbox" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Inbox" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByRole("complementary", { name: "Inbox" })).toBeVisible();
  }

  // Profile settings: rename, handle, theme.
  await openAccountMenu(page, mobile);
  await page.getByRole("dialog").getByRole("link", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeVisible();
  await page.getByLabel("Name").fill("Dawn B.");
  await page.getByLabel("Handle").fill(`dawn-${Date.now()}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as Dawn B.");
  await page.getByLabel("Dark").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await checkPage(page, "settings-profile-dark", project);
  await page.getByLabel("Light").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await checkPage(page, "settings-profile-light", project);
  await page.getByLabel("System").check();

  await page.goto("/settings/security");
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  await checkPage(page, "settings-security", project);

  // Workspace settings: rename and invite; the audit log shows the rename.
  await page.goto(`/${slug}/settings`);
  await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeVisible();
  await page.getByLabel("Workspace name").fill("The Nest (renamed)");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByLabel("Email").fill(uniqueEmail("kimi"));
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByTestId("invite-link")).toContainText("/invite/inv_");
  await page.reload();
  await expect(page.getByRole("list", { name: "Audit log" })).toContainText("workspace.updated");
  await expect(page.getByRole("table")).toContainText("Dawn B.");
  await checkPage(page, "settings-workspace", project);
});
