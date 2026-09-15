import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.4 (spec §5.2, §4 "Peek everywhere"): finding something that was said. Typing in the Search
 * mode, narrowing by kind and channel, opening a result as a peek, and following it to where it
 * was said.
 */

test("search finds a message, narrows it, and opens it as a peek", async ({ page }, info) => {
  test.setTimeout(120_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Wren", uniqueEmail("wren"));
  const slug = await createWorkspace(page, "Search Nest");

  // Two channels, so a filter has something to narrow.
  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("general");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#general" })).toBeVisible({ timeout: 30_000 });

  const composer = page.getByRole("textbox", { name: "Say something in #general" });
  await composer.fill("the sextant needs recalibrating before we sail");
  await composer.press("Enter");
  await expect(
    page.getByRole("log", { name: "Messages in #general" }).getByTestId("message"),
  ).toContainText(["sextant"], { timeout: 30_000 });

  await page.goto(`/${slug}/home`);
  const second = page.getByRole("form", { name: "Start a channel" });
  await second.getByLabel("Name", { exact: true }).fill("galley");
  await second.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#galley" })).toBeVisible({ timeout: 30_000 });
  const galley = page.getByRole("textbox", { name: "Say something in #galley" });
  await galley.fill("sextant-shaped biscuits for the crew");
  await galley.press("Enter");
  await expect(
    page.getByRole("log", { name: "Messages in #galley" }).getByTestId("message"),
  ).toContainText(["biscuits"], { timeout: 30_000 });

  // ── The Search mode ─────────────────────────────────────────────────────────────────────────
  await page.goto(`/${slug}/search`);
  const search = page.getByRole("form", { name: "Search" });
  await expect(search).toBeVisible();
  await search.getByLabel("What are you looking for").fill("sextant");

  const hits = page.getByTestId("search-hit");
  await expect(hits).toHaveCount(2, { timeout: 30_000 });
  // The words that matched are marked in the result, not just somewhere in it.
  await expect(hits.first().locator("mark").first()).toHaveText(/sextant/i);

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // ── Narrowed to one channel ─────────────────────────────────────────────────────────────────
  await search.getByLabel("In", { exact: true }).selectOption({ label: "#galley" });
  await expect(hits).toHaveCount(1, { timeout: 30_000 });
  await expect(hits.first()).toContainText("biscuits");

  // ── A result opens as a peek, and "Open full" goes to where it was said ─────────────────────
  await hits.first().click();
  const peek = page.getByRole("dialog");
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId("peek-text")).toContainText("biscuits");
  await peek.getByRole("link", { name: "Open full" }).click();
  await expect(page.getByRole("region", { name: "#galley" })).toBeVisible({ timeout: 30_000 });

  // ── And nothing is nothing, said plainly ────────────────────────────────────────────────────
  await page.goto(`/${slug}/search`);
  await page
    .getByRole("form", { name: "Search" })
    .getByLabel("What are you looking for")
    .fill("astrolabe");
  await expect(page.getByText("Nothing matches astrolabe")).toBeVisible({ timeout: 30_000 });
});
