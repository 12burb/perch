import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.13 (spec §5.7 "encrypted per-project env; injected into runner, previews, sessions; never
 * into a model context"). The acceptance, in a browser: set DATABASE_URL on a project, ask the
 * agent to print it, and watch the transcript say which name it was instead of what it said.
 */

const SECRET = "postgres://perch:h8Zq2LmZzQw81Pa@db:5432/perch";

test("a session sees DATABASE_URL, and the transcript never repeats it", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Robin", uniqueEmail("env"));
  const slug = await createWorkspace(page, "Env Nest");

  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Agentic");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Agentic" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 60_000 });

  // The Environment card: a value goes in, and only its name comes back.
  const form = page.getByRole("form", { name: "Environment" });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByLabel("Name", { exact: true }).fill("DATABASE_URL");
  await form.getByLabel("Value", { exact: true }).fill(SECRET);
  await form.getByRole("button", { name: "Set variable" }).click();
  const listed = page.getByTestId("env-var").filter({ hasText: "DATABASE_URL" });
  await expect(listed).toBeVisible({ timeout: 30_000 });
  await expect(listed).toContainText("typed here");
  await expect(page.locator("body")).not.toContainText("h8Zq2LmZ");

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // A session in that project: the agent has the variable, and says so.
  await page.getByRole("link", { name: "Open Agentic" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agentic" })).toBeVisible();
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  const start = page.getByRole("form", { name: "Start a session" });
  await start.getByLabel("Engine").selectOption("acp");
  await start.getByRole("button", { name: "Start" }).click();
  const pane = page.getByTestId("session-pane");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 30_000 });

  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await composer.fill("secret?");
  await composer.press("Enter");
  const log = pane.getByRole("log", { name: "Transcript" });
  // What the agent said was the value; what is written down is the name it had.
  await expect(log.getByTestId("transcript-text").last()).toContainText(
    "[redacted: DATABASE_URL]",
    {
      timeout: 60_000,
    },
  );
  await expect(page.locator("body")).not.toContainText("h8Zq2LmZ");
});
