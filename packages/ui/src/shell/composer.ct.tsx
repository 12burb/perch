import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { ComposerDemo } from "./shell.demo.tsx";

test.describe("Composer", () => {
  test("Enter sends, Shift+Enter adds a line, drafts persist, Esc stops a running turn", async ({
    mount,
    page,
  }) => {
    const draftKey = `ct-${Date.now()}`;
    const component = await mount(<ComposerDemo draftKey={draftKey} />);
    const box = page.getByRole("textbox", { name: "Write a message…" });
    await box.fill("hello");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("world");
    await expect(box).toHaveValue("hello\nworld");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("list", { name: "Sent" }).getByRole("listitem")).toHaveText([
      "hello\nworld",
    ]);
    await expect(box).toHaveValue("");

    await box.fill("a draft");
    await component.unmount();
    await mount(<ComposerDemo draftKey={draftKey} />);
    await expect(page.getByRole("textbox", { name: "Write a message…" })).toHaveValue("a draft");
  });

  test("toolbar wraps the selection; the send button is disabled when empty; Esc cancels", async ({
    mount,
    page,
  }) => {
    await mount(<ComposerDemo draftKey={`ct-b-${Date.now()}`} running />);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await page.getByRole("textbox", { name: "Write a message…" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("cancelled")).toHaveText("1");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    const box = page.getByRole("textbox", { name: "Write a message…" });
    await box.fill("word");
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 4));
    await page
      .getByRole("toolbar", { name: "Formatting" })
      .getByRole("button", { name: "Bold" })
      .click();
    await expect(box).toHaveValue("**word**");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("passes axe", async ({ mount, page }) => {
    await mount(<ComposerDemo draftKey={`ct-c-${Date.now()}`} />, {
      hooksConfig: { theme: "light" },
    });
    await expectNoA11yViolations(page);
  });
});
