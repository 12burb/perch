import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.10 (spec §5.7 approval inbox, §4 "Inbox is the launch tab when something needs you").
 *
 * The acceptance: an agent asks for a permission, and it is approved from the inbox on a phone —
 * without opening the session. The spec runs at both viewports; the phone is where it matters.
 */

test("a permission is approved from the inbox, and the queue clears", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Inbox Owner", uniqueEmail("inbox"));
  const slug = await createWorkspace(page, "Inbox Nest");

  // A project with an agent in it, the same way the session spec sets one up.
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Agentic");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Agentic" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open Agentic" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agentic" })).toBeVisible();

  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.getByRole("form", { name: "Start a session" });
  await form.getByLabel("Engine").selectOption("acp");
  await form.getByRole("button", { name: "Start" }).click();
  const pane = page.getByTestId("session-pane");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 30_000 });

  // An edit the agent has to ask about.
  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await pane.getByRole("radio", { name: "Build" }).check({ force: true });
  await composer.fill("edit the notes");
  await composer.press("Enter");
  await expect(pane.getByTestId("session-status")).toHaveText("Needs you", { timeout: 30_000 });

  // The inbox, where what needs a person waits — on a phone, that is the launch tab.
  await page.goto(`/${slug}/inbox`);
  const inbox = page.getByTestId("inbox");
  const item = inbox.getByTestId("inbox-item").filter({ hasText: "Edit notes.txt" });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item).toContainText("Permission");
  await expect(page.getByTestId("inbox-count")).toContainText("1 waiting");

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // Approved from here: the agent carries on, and the row leaves the queue.
  await item.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(inbox.getByTestId("inbox-item")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("inbox-count")).toContainText("0 waiting");

  // The session it belonged to went on without anybody opening it.
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const mine = (await (await fetch("/api/workspaces")).json()) as {
            workspaces: { id: string }[];
          };
          const ws = mine.workspaces[0]?.id ?? "";
          const projects = (await (await fetch(`/api/workspaces/${ws}/projects`)).json()) as {
            projects: { id: string }[];
          };
          const project = projects.projects[0]?.id ?? "";
          const sessions = (await (
            await fetch(`/api/workspaces/${ws}/projects/${project}/sessions`)
          ).json()) as { sessions: { status: string }[] };
          return sessions.sessions[0]?.status ?? "";
        }),
      { timeout: 30_000 },
    )
    .not.toBe("needs_you");

  // On a phone, "/" now lands on Home again: nothing needs anybody.
  if (mobile) {
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/${slug}/home$`), { timeout: 30_000 });
  }
});
