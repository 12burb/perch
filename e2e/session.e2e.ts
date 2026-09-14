import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.12 (spec §5.1 session pane): plan → build → permission → done. A session opens from the
 * Sessions section on the laptop runner's fake ACP agent (scripts/e2e-server.ts registers it as
 * the default agent): a plan turn answers with the mode, a build turn asks for a permission that
 * the prompt answers, the tool cards and diff land in the transcript, the usage footer counts, the
 * session is renamed and forked; axe clean at both viewports.
 */

test("plan, build, a permission, done: the session pane end to end", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  const email = uniqueEmail("session");
  await signUp(page, "Session Owner", email);
  const slug = await createWorkspace(page, "Session Nest");
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Agentic");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Agentic" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open Agentic" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agentic" })).toBeVisible();

  // The Sessions section lives in the sidebar (a sheet on a phone).
  const openSidebar = async () => {
    if (mobile) {
      await page.getByRole("button", { name: "Toggle sidebar" }).click();
    }
  };
  await openSidebar();
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.getByRole("form", { name: "Start a session" });
  await form.getByLabel("Engine").selectOption("acp");
  await form.getByRole("button", { name: "Start" }).click();

  const pane = page.getByTestId("session-pane");
  await expect(pane).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 20_000 });

  // Plan: the fake agent answers a "mode?" turn with the mode it was put in.
  await pane.getByRole("radio", { name: "Plan" }).check({ force: true });
  // The composer form is "Message the agent"; its textbox is named by the placeholder.
  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await composer.fill("mode?");
  await composer.press("Enter");
  const log = pane.getByRole("log", { name: "Transcript" });
  await expect(log.getByTestId("transcript-turn").first()).toContainText("mode?");
  await expect(log.getByTestId("transcript-text").first()).toContainText("plan", {
    timeout: 20_000,
  });
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 20_000 });

  // Build: an edit asks for a permission; Allow once lets it land with its diff.
  await pane.getByRole("radio", { name: "Build" }).check({ force: true });
  await composer.fill("edit the notes");
  await composer.press("Enter");
  const prompt = page.getByRole("region", { name: "Permission for Edit notes.txt" });
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByTestId("session-status")).toHaveText("Needs you");
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);
  await prompt.getByRole("button", { name: "Allow once" }).click();
  await expect(prompt).toContainText("Allowed once");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 20_000 });
  const cards = log.getByTestId("tool-card");
  await expect(cards).toHaveCount(2);
  await cards.last().getByRole("button", { name: "Toggle Edit notes.txt" }).click();
  await expect(cards.last().getByTestId("tool-diff")).toContainText("+written by the agent");
  await expect(log.getByTestId("transcript-text").last()).toContainText("applied the edit");
  await expect(pane.getByTestId("session-usage")).toContainText("in");
  await expect(pane.getByTestId("session-usage")).not.toContainText("0 in · 0 out");

  // Rename, then fork: the fork carries the transcript and opens in the pane.
  await pane.getByRole("button", { name: "Rename" }).click();
  await pane.getByLabel("Session title").fill("Notes work");
  await pane.getByRole("button", { name: "Save" }).click();
  await expect(pane.getByTestId("session-title")).toHaveText("Notes work");
  await pane.getByRole("button", { name: "Fork" }).click();
  await expect(pane.getByTestId("session-title")).toHaveText("Notes work (fork)", {
    timeout: 20_000,
  });
  await expect(pane.getByText("Forked from another session")).toBeVisible();
  await expect(log.getByTestId("tool-card")).toHaveCount(2);
  // The fork is in the list. On a phone the pane is a modal sheet, so it closes first.
  if (mobile) await pane.getByRole("button", { name: "Close session pane" }).click();
  await openSidebar();
  await expect(page.getByRole("button", { name: "Notes work (fork)" })).toBeVisible();
});
