import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.7 (spec §5.1): the terminal drawer in Code mode runs a shell on the project's runner; a
 * reload comes back to the same shell with its scrollback (the acceptance criterion); a file path
 * printed in the terminal is a link that opens the editor; axe clean at both viewports.
 */

test("the terminal survives a reload and its path links open the editor", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("term");
  await signUp(page, "Terminal Owner", email);
  const slug = await createWorkspace(page, "Terminal Nest");
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Shell");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Shell" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open Shell" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Shell" })).toBeVisible();

  // ⌘J's button: the drawer opens with the terminal tab and connects a shell.
  await page.getByRole("button", { name: "Toggle drawer" }).click();
  const screen = page.getByTestId("terminal-screen");
  await expect(screen).toBeVisible();
  await expect(page.getByTestId("terminal-status")).toHaveText("Connected", { timeout: 20_000 });
  const rows = screen.locator(".xterm-rows");
  await screen.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo perch-e2e-$((40+2))");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("perch-e2e-42", { timeout: 20_000 });

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // Reload: the drawer reopens (its state is remembered) and the same shell comes back.
  await page.reload();
  await expect(page.getByTestId("terminal-status")).toHaveText("Reattached to your shell", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("terminal-screen").locator(".xterm-rows")).toContainText(
    "perch-e2e-42",
    { timeout: 20_000 },
  );

  // A path in the output is a link into the editor.
  const screen2 = page.getByTestId("terminal-screen");
  await screen2.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'hello from the terminal\\n' > notes.txt && echo see notes.txt");
  await page.keyboard.press("Enter");
  const rows2 = screen2.locator(".xterm-rows");
  await expect(rows2).toContainText("see notes.txt", { timeout: 20_000 });
  // xterm re-renders its rows every frame, so read positions once and click by coordinates.
  const target = await screen2.evaluate((el) => {
    const rowEls = [...el.querySelectorAll(".xterm-rows > div")];
    const rowEl = rowEls.filter((r) => (r.textContent ?? "").includes("see notes.txt")).pop();
    if (!rowEl) return { ok: false as const, debug: rowEls.map((r) => r.textContent).join("\n") };
    // The run of text holding the path: its width over its length is one cell.
    const span = [...rowEl.querySelectorAll("span")].find((s) =>
      (s.textContent ?? "").includes("notes.txt"),
    );
    if (!span) return { ok: false as const, debug: `no span in: ${rowEl.innerHTML}` };
    const text = span.textContent ?? "";
    const rect = span.getBoundingClientRect();
    const cell = rect.width / Math.max(text.length, 1);
    return {
      ok: true as const,
      x: rect.left + cell * (text.indexOf("notes.txt") + 2.5),
      y: rect.top + rect.height / 2,
    };
  });
  expect(target.ok, JSON.stringify(target)).toBe(true);
  if (target.ok) {
    await page.mouse.move(target.x, target.y);
    // xterm underlines a hovered link (an inline style on the span); the click then activates it.
    await expect(screen2.locator(".xterm-rows span[style*='underline']").first()).toBeVisible({
      timeout: 5_000,
    });
    await page.mouse.click(target.x, target.y);
  }
  const tabs = page.getByRole("tablist", { name: "Open files" });
  await expect(tabs.getByRole("tab", { name: /notes\.txt/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("code-editor")).toContainText("hello from the terminal");
  test.info().annotations.push({ type: "project", description: info.project.name });
});
