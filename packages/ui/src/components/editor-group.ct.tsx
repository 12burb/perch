import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { EditorGroupDemo } from "./editor-group.demo.tsx";

test.describe("EditorGroup", () => {
  test("tabs select, close, and move with the keyboard; breadcrumbs name the path", async ({
    mount,
    page,
  }) => {
    await mount(<EditorGroupDemo />);
    const tabs = page.getByRole("tablist", { name: "Open files" });
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(tabs.getByRole("tab", { name: /index\.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tabpanel", { name: "index.ts" })).toContainText(
      "body of index.ts",
    );
    const crumbs = page.getByRole("navigation", { name: "Breadcrumbs" });
    await expect(crumbs).toContainText("src");
    await expect(crumbs).toContainText("index.ts");
    await expectNoA11yViolations(page);

    await tabs.getByRole("tab", { name: /README\.md/ }).click();
    await expect(page.getByRole("tabpanel", { name: "README.md" })).toContainText(
      "body of README.md",
    );
    // The dirty tab says so for screen readers too.
    await expect(tabs.getByRole("tab", { name: /README\.md/ })).toContainText("unsaved changes");

    await tabs.getByRole("tab", { name: /README\.md/ }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.getByRole("tab", { name: /index\.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tabs.getByRole("tab", { name: /index\.ts/ })).toBeFocused();

    // Delete on a focused tab closes it; the breadcrumb bar's labelled button closes the active one.
    await tabs.getByRole("tab", { name: /README\.md/ }).click();
    await tabs.getByRole("tab", { name: /README\.md/ }).focus();
    await page.keyboard.press("Delete");
    await expect(tabs.getByRole("tab")).toHaveCount(1);
    await expect(tabs.getByRole("tab", { name: /index\.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "Close index.ts" }).click();
    await expect(page.getByText("No file open")).toBeVisible();
  });
});
