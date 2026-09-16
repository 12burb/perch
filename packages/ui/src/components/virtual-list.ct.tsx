import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { VirtualListDemo } from "./virtual-list.demo.tsx";

test.describe("VirtualList", () => {
  test("renders a window of a two-thousand-row list, and scrolling moves the window", async ({
    mount,
    page,
  }) => {
    await mount(<VirtualListDemo />);
    const list = page.getByRole("list", { name: "Rows" });
    await expect(list).toBeVisible();

    // The DOM holds the window, not the list: a few dozen rows out of two thousand.
    const rows = page.getByTestId("row");
    const rendered = await rows.count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(80);
    await expect(rows.first()).toHaveText("Row 0");

    // A reader is still told how long the list really is.
    await expect(list.locator("li").first()).toHaveAttribute("aria-setsize", "2000");
    await expect(list.locator("li").first()).toHaveAttribute("aria-posinset", "1");
    await expectNoA11yViolations(page);

    // Scrolling to the end moves the window rather than growing it.
    await page.getByTestId("rows").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(page.getByText("Row 1999")).toBeVisible();
    expect(await rows.count()).toBeLessThan(80);
    await expect(page.getByText("Row 0", { exact: true })).toHaveCount(0);
  });
});
