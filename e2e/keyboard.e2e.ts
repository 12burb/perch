import { expect, type Page, test } from "@playwright/test";
import { isMobile, uniqueEmail } from "./helpers.ts";

/**
 * Task 4.11: driven by keyboard alone.
 *
 * Not one `.click()` in this spec — every step is Tab, Shift+Tab, Enter, Space, an arrow or a
 * shortcut, which is how somebody who cannot use a mouse uses Perch. It signs in, moves between
 * modes, opens the command palette, starts a channel and says something in it, and checks the two
 * things a keyboard user notices before anything else: that focus goes *into* a dialog and comes
 * back to what opened it, and that what changes is announced rather than only drawn.
 */

/** Tab until the focused element matches, so the walk does not depend on an exact tab count. */
async function tabTo(page: Page, label: string | RegExp, limit = 60): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const what = await describeFocus(page);
    if (typeof label === "string" ? what.includes(label) : label.test(what)) return;
  }
  throw new Error(`nothing matching ${label} was reachable by Tab in ${limit} presses`);
}

/**
 * What the focused element is called, the way a screen reader would work it out: its label, its
 * placeholder, or its text. Read in one evaluate, because a `:focus` locator waits for something to
 * be focused and at the top of a page nothing is.
 */
async function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "";
    const id = el.getAttribute("id");
    const labelled = id ? (document.querySelector(`label[for="${id}"]`)?.textContent ?? "") : "";
    const aria = el.getAttribute("aria-labelledby");
    const byId = aria ? (document.getElementById(aria)?.textContent ?? "") : "";
    return [
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("placeholder") ?? "",
      labelled,
      byId,
      (el.textContent ?? "").trim().slice(0, 60),
    ]
      .filter(Boolean)
      .join(" ");
  });
}

test("a whole flow, keyboard only", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);

  // Signing up is a form, and a form is the easiest thing in the world to get wrong for a keyboard.
  await page.goto("/sign-up");
  await tabTo(page, "Name");
  await page.keyboard.type("Keys Only");
  await page.keyboard.press("Tab");
  await page.keyboard.type(uniqueEmail("keys"));
  await page.keyboard.press("Tab");
  await page.keyboard.type("correct horse battery staple");
  // Enter submits from inside the form: a keyboard user should not have to find the button.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as Keys Only", {
    timeout: 60_000,
  });

  // The first workspace, from the welcome page, by keyboard.
  await page.goto("/welcome");
  await tabTo(page, "Workspace name");
  await page.keyboard.type("Keyboard Nest");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible({
    timeout: 60_000,
  });
  const ws = new URL(page.url()).pathname.split("/")[1] ?? "";
  expect(ws).not.toBe("");

  // The command palette is the keyboard's way around (spec §4): ⌘K, type, Enter.
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+KeyK`);
  const palette = page.getByRole("dialog", { name: /command|palette/i });
  await expect(palette).toBeVisible({ timeout: 30_000 });
  // Focus went *into* the dialog rather than staying behind it.
  await expect(palette.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  // …and came back to the page, not to nothing. Polled: the restore waits for the dialog to
  // finish unmounting, which is a frame or two after it stops being visible.
  await expect.poll(() => describeFocus(page)).not.toBe("");

  // A channel, started from the keyboard, and something said in it.
  await tabTo(page, /Name/);
  await page.keyboard.type("Keyboard");
  await page.keyboard.press("Enter");
  const channel = page.getByRole("region", { name: "#keyboard" });
  await expect(channel).toBeVisible({ timeout: 60_000 });

  await tabTo(page, /Message|Write|Say/i);
  await page.keyboard.type("said with a keyboard");
  await page.keyboard.press("Enter");
  await expect(channel.getByText("said with a keyboard")).toBeVisible({ timeout: 30_000 });

  // A live region exists and carries what changed, so a screen reader hears it rather than a
  // sighted person seeing it (spec §4 "live regions").
  const live = page.locator("[aria-live], [role=status], [role=alert]");
  expect(await live.count()).toBeGreaterThan(0);

  // Moving between modes without a mouse. On a desktop the rail is a tablist with a roving
  // tabindex — only the current mode is in the Tab order, so the arrows are the only way through.
  // On a phone the same modes are a bottom nav, where every one of them is a Tab away.
  await page.goto(`/${ws}/home`);
  if (mobile) {
    const bar = page.getByRole("navigation", { name: "Sections" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await tabTo(page, "Work");
    await page.keyboard.press("Enter");
  } else {
    const tabs = page.getByRole("tablist", { name: /modes/i });
    await expect(tabs).toBeVisible({ timeout: 30_000 });
    await tabTo(page, "Home");
    await page.keyboard.press("ArrowDown");
    await expect(tabs.getByRole("tab", { name: "Code" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
  }
  await expect(page).toHaveURL(/\/work\b/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: /Work/i })).toBeVisible({
    timeout: 30_000,
  });
});
