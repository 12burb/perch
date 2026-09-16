import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.18 (spec §5.1, §4, §11): quick actions and the reasoning level.
 *
 * §11's acceptance is "a custom action runs from the session pane and from ⌘K", and this spec does
 * both: the button in the pane sends the action's prompt as a turn, and the same action fired from
 * the command palette — with the pane closed — opens a session and sends it there.
 */

const CONFIG = {
  run: { dev: "echo hello-from-the-run-command" },
  actions: [
    { id: "ask-mode", name: "Which mode are we in", prompt: "mode?", mode: "plan" },
    { id: "dev", name: "Start the dev server", run: "dev" },
  ],
};

test("a quick action runs from the session pane and from ⌘K", async ({ page }, info) => {
  test.setTimeout(240_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Action Owner", uniqueEmail("action"));
  const slug = await createWorkspace(page, "Action Nest");
  await page.goto(`/${slug}/code`);

  // A project with a checked-in .perch/project.json, written the way a clone would bring one.
  await page.getByLabel("Project name").fill("Acted");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Acted" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 90_000 });

  const wrote: boolean = await page.evaluate(async (config) => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const listed = (await (await fetch(`/api/workspaces/${ws}/projects`)).json()) as {
      projects: { id: string; name: string }[];
    };
    const id = listed.projects.find((one) => one.name === "Acted")?.id ?? "";
    await fetch(`/api/workspaces/${ws}/projects/${id}/fs/write`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: ".perch/project.json",
        content: JSON.stringify(config, null, 2),
      }),
    });
    const res = await fetch(`/api/workspaces/${ws}/projects/${id}/config/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    return res.ok;
  }, CONFIG);
  expect(wrote).toBe(true);

  await page.goto(`/${slug}/code/acted`);
  await expect(page.getByRole("heading", { level: 1, name: "Acted" })).toBeVisible();

  // A session to act in. The Sessions section lives in the sidebar, a sheet on a phone.
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.getByRole("form", { name: "Start a session" });
  await form.getByLabel("Engine").selectOption("acp");
  await form.getByRole("button", { name: "Start" }).click();
  const pane = page.getByTestId("session-pane");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 60_000 });

  // The pane's own row of quick actions: the project's run command and its custom action.
  const quick = pane.getByRole("list", { name: "Quick actions" });
  await expect(quick.getByRole("button", { name: "Which mode are we in" })).toBeVisible();
  await expect(quick.getByRole("button", { name: "dev" })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // Pressing it sends the action's prompt as a turn, in the action's own mode — the fake agent
  // answers a "mode?" turn with the mode it was put in, which is how the mode is visible at all.
  await quick.getByRole("button", { name: "Which mode are we in" }).click();
  const log = pane.getByRole("log", { name: "Transcript" });
  await expect(log.getByTestId("transcript-turn").first()).toContainText("mode?");
  await expect(log.getByTestId("transcript-text").first()).toContainText("plan", {
    timeout: 60_000,
  });
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 30_000 });

  // How hard it thinks is the composer's to set, and it is the session's from then on — which is
  // asked of the api rather than the DOM, because the panel is a sheet on a phone.
  await pane.getByTestId("session-reasoning").selectOption("high");
  await expect(pane.getByTestId("session-reasoning")).toHaveValue("high");
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const id = new URL(window.location.href).searchParams.get("session") ?? "";
          const res = await fetch(`/api/sessions/${id}`);
          return ((await res.json()) as { reasoning?: string }).reasoning ?? "";
        }),
      { timeout: 30_000 },
    )
    .toBe("high");

  // The same action from ⌘K, with no session pane on screen: the palette opens a session for it.
  await page.goto(`/${slug}/code/acted`);
  await expect(page.getByRole("heading", { level: 1, name: "Acted" })).toBeVisible();
  await expect(page.getByTestId("session-pane")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("Which mode");
  await palette.getByRole("option", { name: "Which mode are we in" }).first().click();

  const reopened = page.getByTestId("session-pane");
  await expect(reopened).toBeVisible({ timeout: 60_000 });
  await expect(reopened.getByRole("log", { name: "Transcript" })).toContainText("mode?", {
    timeout: 60_000,
  });

  await info.attach("actions", { body: await page.screenshot(), contentType: "image/png" });
});
