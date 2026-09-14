import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { DiffViewDemo } from "./diff-view.demo.tsx";

test.describe("DiffView", () => {
  test("labeled hunks with line numbers; accept, reject, accept all, open", async ({
    mount,
    page,
  }) => {
    await mount(<DiffViewDemo />);
    const view = page.getByRole("region", { name: "Changes" });
    await expect(view.getByRole("heading", { level: 3 })).toHaveText(["notes.txt", "extra.txt"]);
    await expect(view.getByRole("heading", { level: 4 })).toHaveCount(4);
    await expect(view.getByRole("heading", { level: 4 }).first()).toContainText("Hunk 1 of 3");
    const lines = view.getByTestId("diff-line");
    await expect(lines.first()).toContainText("line 1");
    await expect(lines.nth(1)).toHaveAttribute("data-kind", "del");
    await expect(lines.nth(2)).toHaveAttribute("data-kind", "add");
    await expect(lines.nth(2)).toContainText("added");
    await expectNoA11yViolations(page);

    await view.getByRole("button", { name: "Accept hunk 1 of notes.txt" }).click();
    await expect(view.getByTestId("diff-hunk").first()).toHaveAttribute("data-decision", "accept");
    await expect(view.getByTestId("diff-hunk").first()).toContainText("Accepted");
    await view.getByRole("button", { name: "Reject hunk 3 of notes.txt" }).click();
    await expect(view.getByRole("heading", { level: 4 })).toHaveCount(3);
    await expect(view.getByRole("heading", { level: 4 }).nth(1)).toContainText("Hunk 2 of 2");
    await view.getByRole("button", { name: "Accept all in notes.txt" }).click();
    await expect(view.getByRole("button", { name: /hunk \d of notes.txt/ })).toHaveCount(0);
    await view.getByRole("button", { name: "Reject all in extra.txt" }).click();
    await view.getByRole("button", { name: "Open extra.txt" }).click();
    await expect(page.getByTestId("log")).toHaveText(
      "notes.txt#0:accept notes.txt#2:reject notes.txt:*:accept extra.txt:*:reject open:extra.txt",
    );
    await expectNoA11yViolations(page);
  });

  test("a long diff renders a window of rows", async ({ mount, page }) => {
    await mount(<DiffViewDemo long />);
    const view = page.getByRole("region", { name: "Changes" });
    await expect(view.getByTestId("diff-line").first()).toBeVisible();
    expect(await view.getByTestId("diff-line").count()).toBeLessThan(200);
  });
});
