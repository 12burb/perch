import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * axe for a mounted component: the page-level rules (a page needs a main landmark, an h1, and content
 * inside landmarks) are the app's job (e2e), not a component's; everything else must pass (ADR-0055).
 */
export const PAGE_LEVEL_RULES = ["region", "page-has-heading-one", "landmark-one-main"];

export async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).disableRules(PAGE_LEVEL_RULES).analyze();
  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) =>
          `${v.id}: ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary ?? ""}`).join("\n  ")}`,
      )
      .join("\n");
    throw new Error(`axe violations:\n${summary}`);
  }
}
