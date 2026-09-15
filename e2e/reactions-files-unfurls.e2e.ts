import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.3 (spec §5.2): what a message carries besides words. An emoji put on it and taken off
 * again, a file that shows itself, and a Perch identifier that unfurls into what it points at.
 *
 * Web push has its own spec (`push.e2e.ts`), because it is the browser's machinery rather than the
 * channel's.
 */

// A one-pixel PNG: small enough to write here, real enough for a browser to draw.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("react, attach a file, and paste an identifier that unfurls", async ({ page }, info) => {
  test.setTimeout(120_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Wren", uniqueEmail("wren"));
  await createWorkspace(page, "Extras Nest");

  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("general");
  await form.getByRole("button", { name: "Create channel" }).click();
  const channel = page.getByRole("region", { name: "#general" });
  await expect(channel).toBeVisible({ timeout: 30_000 });

  const composer = page.getByRole("textbox", { name: "Say something in #general" });
  const flow = page.getByRole("log", { name: "Messages in #general" });

  // ── A reaction: put one on from the toolbar, and take it off from the pill ──────────────────
  await composer.fill("shipping it");
  await composer.press("Enter");
  const message = flow.getByTestId("message").filter({ hasText: "shipping it" });
  await expect(message).toBeVisible({ timeout: 30_000 });

  await message.getByRole("button", { name: "React", exact: true }).click();
  await page.getByRole("toolbar", { name: "React with" }).getByRole("button").first().click();
  const pill = message.getByTestId("reaction");
  await expect(pill).toHaveCount(1, { timeout: 30_000 });
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await expect(pill).toContainText("1");

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // Clicking your own pill takes it off, and the pill goes with it.
  await pill.click();
  await expect(message.getByTestId("reaction")).toHaveCount(0, { timeout: 30_000 });

  // ── A file: attached from the composer, shown in the flow, and downloadable ─────────────────
  await page.getByTestId("attach").setInputFiles({
    name: "a-pixel.png",
    mimeType: "image/png",
    buffer: PIXEL,
  });
  const file = flow.getByTestId("file").first();
  await expect(file).toBeVisible({ timeout: 30_000 });
  await expect(file).toContainText("a-pixel.png");
  const image = file.getByRole("img", { name: "a-pixel.png" });
  await expect(image).toBeVisible();
  // The preview really is the file: the browser drew it rather than showing a broken image.
  await expect
    .poll(async () => image.evaluate((node: HTMLImageElement) => node.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect(file).toHaveAttribute("href", /\/api\/files\/[0-9a-f-]+$/);

  // ── An unfurl: an identifier in a message becomes a card for what it points at ──────────────
  await composer.fill("see channel:general for the rest");
  await composer.press("Enter");
  const said = flow.getByTestId("message").filter({ hasText: "see channel:general" });
  await expect(said).toBeVisible({ timeout: 30_000 });
  const card = said.getByTestId("unfurl");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("#general");
});
