import { expect, test } from "@playwright/experimental-ct-react";
import { expectNoA11yViolations } from "../../playwright/axe.ts";
import { PrimitivesDemo } from "../shell/shell.demo.tsx";

test.describe("primitives", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const density of ["comfortable", "compact"] as const) {
      test(`buttons, badges, fields, and the empty state pass axe (${theme}, ${density})`, async ({
        mount,
        page,
      }) => {
        await mount(<PrimitivesDemo />, { hooksConfig: { theme, density } });
        await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
        await expect(page.getByText("BOT")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription(
          "Shown to your team",
        );
        await expect(page.getByRole("textbox", { name: "Bio" })).toHaveAttribute(
          "aria-invalid",
          "true",
        );
        await expect(page.getByRole("alert")).toHaveText("Too long");
        await expect(page.getByRole("status")).toContainText("No channels yet");
        await expectNoA11yViolations(page);
      });
    }
  }
});
