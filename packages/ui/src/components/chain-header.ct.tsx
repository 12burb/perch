import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { ChainHeader } from "./chain-header.tsx";

const HOPS = [
  { hop: 1, fromName: null, toName: "Lead", mode: "consult" as const },
  { hop: 2, fromName: "Lead", toName: "Gamma", mode: "fanout" as const },
  { hop: 3, fromName: "Lead", toName: "Delta", mode: "fanout" as const },
];

test.describe("ChainHeader", () => {
  test("says who is in the thread, how far it went, and what it cost", async ({ mount, page }) => {
    await mount(<ChainHeader hops={HOPS} costUsd={0.42} stopped={false} />);
    const header = page.getByTestId("chain-header");
    await expect(header).toContainText("3 hops");
    await expect(header).toContainText("$0.42");
    for (const name of ["Lead", "Gamma", "Delta"]) await expect(header).toContainText(name);
    await expect(page.getByTestId("chain-stopped")).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test("a paused chain says why", async ({ mount, page }) => {
    await mount(
      <ChainHeader
        hops={HOPS}
        costUsd={0.004}
        stopped
        breaker="these two have been going back and forth"
      />,
    );
    await expect(page.getByTestId("chain-stopped")).toContainText("back and forth");
    // A fraction of a cent is said in words rather than rounded away to nothing.
    await expect(page.getByTestId("chain-header")).toContainText("under a cent");
    await expectNoA11yViolations(page);
  });

  test("nothing to say when nothing has happened", async ({ mount, page }) => {
    await mount(<ChainHeader hops={[]} costUsd={0} stopped={false} />);
    await expect(page.getByTestId("chain-header")).toHaveCount(0);
  });
});
