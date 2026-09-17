import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * The Hub (task 4.12).
 *
 * The acceptance the task names — a bot installed from the Hub answers — is proved in
 * `apps/api/test/hub.test.ts`, where there is a model to answer with. This is the other half: that
 * the Hub is a place in the app a person can reach, filter, search and press Install in, and that
 * what it says happened has happened.
 *
 * A bot is the one installed here because it needs nothing else: no runner, no model, no OAuth.
 */

test("the Hub lists what this build ships, and installs a bot from it", async ({ page }) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("hub");
  await signUp(page, "Hub Browser", email);
  const slug = await createWorkspace(page, "Hub Nest");

  await page.goto(`/${slug}/hub`);
  await expect(page.getByRole("heading", { level: 1, name: "Hub" })).toBeVisible({
    timeout: 30_000,
  });

  // All four kinds are here, each with a count that is the index's rather than the page's.
  const filter = page.getByRole("group", { name: "What kind" });
  for (const kind of ["Connections", "Bots", "Skills", "Templates"]) {
    await expect(filter.getByRole("button", { name: new RegExp(kind) })).toBeVisible();
  }
  const cards = page.getByRole("list", { name: "Hub" }).getByRole("listitem");
  await expect(cards.first()).toBeVisible();
  const everything = await cards.count();
  expect(everything).toBeGreaterThan(20);

  // Filtering narrows it, and every card left says what it is.
  await filter.getByRole("button", { name: /Bots/ }).click();
  await expect(cards.first()).toBeVisible();
  const bots = await cards.count();
  expect(bots).toBeLessThan(everything);
  expect(bots).toBeGreaterThan(3);

  // Searching narrows it further, without a round trip: the index is already here.
  await page.getByLabel("Search the Hub").fill("newsroom");
  await expect(cards).toHaveCount(1);
  const card = cards.first();
  await expect(card).toContainText("Grok Newsroom");
  // The row says what the button will do before it is pressed.
  await expect(card).toContainText("Creates @grok in this workspace");

  await page.getByRole("button", { name: "Install: Grok Newsroom" }).click();
  await expect(card.getByRole("status")).toContainText("@grok is here", { timeout: 30_000 });

  await new AxeBuilder({ page }).analyze().then((scan) => expect(scan.violations).toEqual([]));

  // And it is really there: the Forge lists it like any other bot in this workspace.
  await page.goto(`/${slug}/settings`);
  await expect(page.getByText("@grok").first()).toBeVisible({ timeout: 30_000 });

  // Installing it twice is not a second bot, and the Hub says so rather than failing.
  await page.goto(`/${slug}/hub`);
  await page.getByLabel("Search the Hub").fill("newsroom");
  await page.getByRole("button", { name: "Install: Grok Newsroom" }).click();
  await expect(
    page.getByRole("list", { name: "Hub" }).getByRole("listitem").first().getByRole("status"),
  ).toContainText("already", {
    timeout: 30_000,
  });
});

test("a connection sends you to where you can actually connect it", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Hub Connector", uniqueEmail("hubconn"));
  const slug = await createWorkspace(page, "Hub Connect Nest");
  await page.goto(`/${slug}/hub`);
  await page.getByLabel("Search the Hub").fill("GitHub");
  const card = page
    .getByRole("list", { name: "Hub" })
    .getByRole("listitem")
    .filter({ hasText: "GitHub" })
    .first();
  await expect(card).toContainText("Opens the Connections card");
  await card.getByRole("button", { name: /^Install/ }).click();
  // Nothing was connected: a token or a sign-in is a person's to give, so it goes there.
  await expect(page).toHaveURL(/\/settings\?connect=github/, { timeout: 30_000 });
});
