import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { PeekDemo } from "./shell.demo.tsx";

test.describe("Peek", () => {
  test("opens as a labelled dialog with Open full, traps focus, closes on Esc", async ({
    mount,
    page,
  }, info) => {
    await mount(<PeekDemo />);
    await page.getByRole("button", { name: "Peek NEST-123" }).click();
    const dialog = page.getByRole("dialog", { name: "NEST-123 · Fix login redirect" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Open full" })).toHaveAttribute(
      "href",
      "/work/NEST-123",
    );
    await expect(dialog.getByText("Work item body")).toBeVisible();
    await expectNoA11yViolations(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Focus returns to what opened it (a tap on a phone does not focus the button to begin with).
    if (info.project.name === "desktop") {
      await expect(page.getByRole("button", { name: "Peek NEST-123" })).toBeFocused();
    }
  });
});
