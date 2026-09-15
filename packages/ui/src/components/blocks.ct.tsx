import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { BlocksDemo } from "./blocks.demo.tsx";

test.describe("BlockRenderer", () => {
  test("button, select, form and approve_deny answer in place; progress is read, not pressed", async ({
    mount,
    page,
  }) => {
    await mount(<BlocksDemo />);
    await expectNoA11yViolations(page);

    // Progress is a bot's to move: it reports, it takes no press.
    const progress = page.getByRole("progressbar", { name: "Building" });
    await expect(progress).toHaveAttribute("aria-valuenow", "42");

    // Approve/deny: the decision replaces the buttons and says who made it.
    const approve = page.getByTestId("block-approve");
    await approve.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("acted")).toHaveText('b-approve:{"decision":"approved"}');
    await expect(approve.getByRole("button")).toHaveCount(0);
    await expect(approve).toContainText("Approved");
    await expect(approve.getByTestId("block-answer")).toContainText("Ada");

    // A button carries its own value.
    await page.getByTestId("block-button").getByRole("button", { name: "Run the tests" }).click();
    await expect(page.getByTestId("acted")).toHaveText('b-button:{"value":"Run the tests"}');
    await expect(
      page.getByTestId("block-button").getByRole("button", { name: "Run the tests" }),
    ).toBeDisabled();

    // A select sends what was chosen, and afterwards shows the option's label, not its value.
    const select = page.getByTestId("block-select");
    await select.getByLabel("Which environment").selectOption("production");
    await select.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("acted")).toHaveText('b-select:{"value":"production"}');
    await expect(select.getByTestId("block-chosen")).toHaveText("Production");

    // A form sends its fields; an empty required one never leaves the browser.
    const form = page.getByRole("form", { name: "Tell the team" });
    await form.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByTestId("acted")).toHaveText('b-select:{"value":"production"}');
    await form.getByLabel("Title · required").fill("Deploying now");
    await form.getByLabel("Notes").fill("Watch the logs");
    await form.getByLabel("Urgency").selectOption("high");
    await form.getByLabel("Tell everyone").check();
    await form.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByTestId("acted")).toHaveText(
      'b-form:{"title":"Deploying now","body":"Watch the logs","urgency":"high","notify":"true"}',
    );
    const answered = page.getByTestId("block-form");
    await expect(answered.getByTestId("block-value").first()).toHaveText("Deploying now");
    await expect(answered).toContainText("Ada");
    await expectNoA11yViolations(page);
  });

  test("a reader sees the question and cannot answer it", async ({ mount, page }) => {
    await mount(<BlocksDemo readOnly />);
    await expect(page.getByTestId("block-button").getByRole("button")).toBeDisabled();
    await expect(page.getByTestId("block-approve").getByRole("button").first()).toBeDisabled();
    await expect(
      page.getByRole("form", { name: "Tell the team" }).getByRole("button"),
    ).toBeDisabled();
    await expectNoA11yViolations(page);
  });

  test("works at 390 px", async ({ mount, page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await mount(<BlocksDemo />);
    await expect(
      page.getByTestId("block-approve").getByRole("button", { name: "Approve" }),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(overflow).toBe(true);
    await expectNoA11yViolations(page);
  });
});
