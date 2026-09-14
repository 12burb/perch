import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { SessionTranscriptDemo } from "./session-transcript.demo.tsx";

test.describe("SessionTranscript", () => {
  test("turns, replies, tool cards that open, a permission answered, and a long list virtualized", async ({
    mount,
    page,
  }) => {
    await mount(<SessionTranscriptDemo />);
    const log = page.getByRole("log", { name: "Transcript" });
    await expect(log.getByTestId("transcript-turn")).toContainText("Add a notes file");
    await expect(log.getByTestId("transcript-text").first()).toContainText("Reading the project");
    const cards = log.getByTestId("tool-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1)).toContainText("Edit notes.txt");
    await expectNoA11yViolations(page);

    // A card opens to its arguments, output, and diff.
    await cards.nth(1).getByRole("button", { name: "Toggle Edit notes.txt" }).click();
    await expect(cards.nth(1).getByTestId("tool-diff")).toContainText("notes.txt");
    await expect(cards.nth(1).getByTestId("tool-diff")).toContainText("+hello");
    await expectNoA11yViolations(page);

    // The permission prompt takes an answer and shows it.
    const prompt = page.getByRole("region", { name: "Permission for Edit notes.txt" });
    await prompt.getByRole("button", { name: "Always this session" }).click();
    await expect(page.getByTestId("answered")).toHaveText("p1:always");
    await expect(prompt).toContainText("Always allowed for this session");
    await expect(prompt.getByRole("button")).toHaveCount(0);

    // Many rows: only a window of them is in the DOM.
    await page.getByRole("button", { name: "Add many" }).click();
    await expect(log.getByTestId("transcript-text").last()).toContainText("line 299");
    const rendered = await log.getByTestId("transcript-text").count();
    expect(rendered).toBeLessThan(120);
  });
});
