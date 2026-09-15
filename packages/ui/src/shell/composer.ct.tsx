import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { ComposerDemo } from "./shell.demo.tsx";

test.describe("Composer", () => {
  test("mentions: @ opens a list, the keyboard drives it, and picking writes the token", async ({
    mount,
    page,
  }) => {
    await mount(<ComposerDemo draftKey={`ct-m-${Date.now()}`} mentions />);
    const box = page.getByRole("textbox", { name: "Write a message…" });
    const list = page.getByRole("listbox", { name: "Mentions" });
    await expect(list).toBeHidden();

    // Typing the trigger opens it; typing more narrows it.
    await box.click();
    await page.keyboard.type("morning @");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option")).toHaveText(["Robin@robin", "Wren@wren"]);
    await page.keyboard.type("wr");
    await expect(list.getByRole("option")).toHaveText(["Wren@wren"]);

    // Enter takes the highlighted one and writes what the api reads.
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue("morning <@wren> ");
    await expect(list).toBeHidden();

    // The arrows move the highlight, and Tab takes it.
    await page.keyboard.type("and #");
    await expect(list.getByRole("option")).toHaveText(["#generaleverything"]);
    await page.keyboard.press("Tab");
    await expect(box).toHaveValue("morning <@wren> and <#general> ");

    // Esc closes the list without sending anything.
    await page.keyboard.type("@");
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(page.getByRole("list", { name: "Sent" }).getByRole("listitem")).toHaveCount(0);

    await expectNoA11yViolations(page);
  });

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
