import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { PaletteDemo } from "./shell.demo.tsx";

test.describe("CommandPalette", () => {
  test("⌘K opens it, typing filters, Enter runs the selected command, Esc closes", async ({
    mount,
    page,
  }) => {
    await mount(<PaletteDemo />);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.type("approv");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByRole("option", { name: /Go to Inbox/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("ran")).toHaveText("go-inbox");

    await page.getByRole("button", { name: "Open palette" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("option")).toHaveCount(3);
    await expect(dialog.getByRole("option", { name: /New session/ })).toContainText(/⌘L|Ctrl\+L/);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("closing it gives focus back to whatever opened it", async ({ mount, page }) => {
    await mount(<PaletteDemo />);
    // Tabbed to the button and opened with Enter, which is how a keyboard gets here. Closing it
    // must give focus back to the button, or that keyboard has lost its place.
    const button = page.getByRole("button", { name: "Open palette" });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test("opened by ⌘K with nothing focused, it still leaves focus on the page", async ({
    mount,
    page,
  }) => {
    // Nothing has been tabbed to on this page, so there is nowhere to go back to. Focus has to
    // land on the page all the same, or the next Tab starts the document over from the top.
    await mount(<PaletteDemo />);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ""))
      .toBe("MAIN");
  });

  test("passes axe while open", async ({ mount, page }) => {
    await mount(<PaletteDemo />, { hooksConfig: { theme: "dark" } });
    await page.getByRole("button", { name: "Open palette" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
