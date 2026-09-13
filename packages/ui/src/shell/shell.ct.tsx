import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { ShellDemo } from "./shell.demo.tsx";

test.describe("Shell", () => {
  test("renders the five regions as landmarks and toggles them with the keyboard", async ({
    mount,
    page,
  }, info) => {
    const mobile = info.project.name === "mobile";
    await mount(<ShellDemo />);
    if (mobile) {
      // Phone: main only, the tab bar below, the sidebar as a sheet.
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Modes" })).toHaveCount(0);
      await page.getByRole("button", { name: "Toggle sidebar" }).click();
      await expect(page.getByRole("dialog", { name: "Channels" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Channels" })).toHaveCount(0);
      return;
    }
    await expect(page.getByRole("navigation", { name: "Modes" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Channels" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Thread" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Drawer" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByRole("complementary", { name: "Channels" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+.");
    await expect(page.getByRole("complementary", { name: "Thread" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.getByRole("region", { name: "Drawer" })).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle panel" }).click();
    await expect(page.getByRole("complementary", { name: "Thread" })).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(page.getByRole("complementary", { name: "Thread" })).toHaveCount(0);
  });

  test("rail tabs, sidebar sections, and drawer tabs are keyboard complete", async ({
    mount,
    page,
  }, info) => {
    test.skip(info.project.name === "mobile", "desktop regions only");
    await mount(<ShellDemo />);
    const tabs = page.getByRole("tablist", { name: "Modes" });
    await expect(tabs.getByRole("tab", { name: "Home" })).toHaveAttribute("aria-selected", "true");
    await tabs.getByRole("tab", { name: "Home" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(tabs.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Mode: code")).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Inbox" })).toContainText("3");

    const section = page.getByRole("button", { name: /^Channels/ });
    await expect(section).toHaveAttribute("aria-expanded", "true");
    await section.click();
    await expect(section).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "general" })).toBeHidden();
    await expect(section).toContainText("2");
    await section.click();
    await expect(page.getByRole("button", { name: "general" })).toBeVisible();
    await expect(page.getByRole("button", { name: "general" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const drawerTabs = page.getByRole("tablist", { name: "Drawer" });
    await drawerTabs.getByRole("tab", { name: "Terminal" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(drawerTabs.getByRole("tab", { name: "Console" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tabpanel")).toContainText("console");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`passes axe in the ${theme} theme`, async ({ mount, page }) => {
      await mount(<ShellDemo />, { hooksConfig: { theme } });
      await expectNoA11yViolations(page);
    });
  }
});
