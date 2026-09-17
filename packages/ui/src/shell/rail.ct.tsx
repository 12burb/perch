import { expect, test } from "@playwright/experimental-ct-react";
import { RailLinksDemo } from "./shell.demo.tsx";

/**
 * Task 4.11: the rail an app actually ships — one anchor per mode, spread with `tabProps`.
 *
 * This is the composition the web app uses, and the one where a keyboard was stuck: a roving
 * tabindex leaves five of the six tabs out of the Tab order, so without arrow keys on the tab
 * itself there is no way to change mode without a mouse.
 */
test.describe("the rail rendered as links", () => {
  test("arrows, Home and End move between the modes", async ({ mount, page }) => {
    await mount(<RailLinksDemo />);
    const tabs = page.getByRole("tablist", { name: "Modes" });
    await expect(tabs.getByRole("tab")).toHaveCount(6);

    // Only the selected tab is in the Tab order — that is the roving tabindex, and it is correct.
    await expect(tabs.getByRole("tab", { name: "Home" })).toHaveAttribute("tabindex", "0");
    await expect(tabs.getByRole("tab", { name: "Code" })).toHaveAttribute("tabindex", "-1");

    await tabs.getByRole("tab", { name: "Home" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(tabs.getByRole("tab", { name: "Code" })).toBeFocused();
    await expect(page.getByRole("main")).toHaveText("Mode: code");

    await page.keyboard.press("End");
    await expect(tabs.getByRole("tab", { name: "Search" })).toBeFocused();
    await expect(page.getByRole("main")).toHaveText("Mode: search");

    // Past the end it wraps, so a keyboard never runs out of rail.
    await page.keyboard.press("ArrowDown");
    await expect(tabs.getByRole("tab", { name: "Home" })).toBeFocused();
    await expect(page.getByRole("main")).toHaveText("Mode: home");

    await page.keyboard.press("ArrowUp");
    await expect(tabs.getByRole("tab", { name: "Search" })).toBeFocused();
  });
});
