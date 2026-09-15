import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { InboxList } from "./inbox-list.tsx";

const ROWS = [
  {
    id: "1",
    kind: "permission" as const,
    title: "Write a file",
    body: "fs.write",
    url: "/nest/code?session=s1",
    status: "open" as const,
    snoozedUntil: null,
    createdAt: "2026-09-15T09:00:00.000Z",
  },
  {
    id: "2",
    kind: "mention" as const,
    title: "Ada named you in #general",
    body: "can you look at the deploy?",
    url: "/nest/home/c1",
    status: "open" as const,
    snoozedUntil: null,
    createdAt: "2026-09-15T08:00:00.000Z",
  },
];

test.describe("InboxList", () => {
  test("says what needs you, and hands back what was chosen", async ({ mount, page }) => {
    const resolved: string[][] = [];
    const answered: [string[], string][] = [];
    const component = await mount(
      <InboxList
        rows={ROWS}
        onResolve={(ids) => resolved.push(ids)}
        onAnswer={(ids, decision) => answered.push([ids, decision])}
      />,
    );
    await expect(component.getByTestId("inbox-item")).toHaveCount(2);
    await expect(component).toContainText("fs.write");
    await expect(component).toContainText("Permission");

    // A permission is answered where it is read: no going to the session for it (spec §5.7).
    await component
      .getByTestId("inbox-item")
      .first()
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    expect(answered).toEqual([[["1"], "allow"]]);

    // Anything else is just put away, one row at a time.
    await component.getByTestId("inbox-item").last().getByRole("button", { name: "Done" }).click();
    expect(resolved).toEqual([["2"]]);

    // Or several at once, which is what a queue is for ("batch approve").
    await component.getByRole("checkbox", { name: "Choose everything here" }).check();
    await expect(component.getByTestId("inbox-chosen")).toContainText("2 chosen");
    await component.getByRole("button", { name: "Approve 1" }).click();
    expect(answered[1]).toEqual([["1"], "allow"]);
    await component.getByRole("button", { name: "Mark 1 done" }).click();
    expect(resolved[1]).toEqual(["2"]);
    await expectNoA11yViolations(page);
  });

  test("nothing waiting says so", async ({ mount, page }) => {
    const component = await mount(<InboxList rows={[]} />);
    await expect(component).toContainText("Nothing needs you");
    await expectNoA11yViolations(page);
  });
});
