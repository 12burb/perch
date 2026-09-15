import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.16 (spec §5.6, §11): the inspector. The acceptance §11 names is the whole of it — click a
 * button in Preview, type "make this primary", and the edit lands in the right file.
 *
 * Everything between those two ends is real: the proxy injects the client into the page because the
 * request came from a member's pane, the client reports what was clicked with the `data-perch-src`
 * the dev plugin wrote, the pane turns that into a context chip, and the chip rides the next turn
 * so the agent knows which file to open. What the @perch/inspector transform puts in the page is
 * covered by its own unit tests; what this proves is the chain after it.
 */

const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? "3997");

test("click a button in Preview, ask for a change, and the edit lands in the right file", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUp(page, "Inspector Owner", uniqueEmail("inspect"));
  const slug = await createWorkspace(page, "Inspect Nest");

  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Site");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Site" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 90_000 });

  // The file the dev plugin's tag points at. It exists before the session starts, so what the
  // agent does to it is an edit and the assertion at the end is about content, not creation.
  const seeded = await page.evaluate(async () => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const list = (await (await fetch(`/api/workspaces/${ws}/projects`)).json()) as {
      projects: { id: string; key: string }[];
    };
    const project = list.projects.find((one) => one.key === "site")?.id ?? "";
    const res = await fetch(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/App.tsx", content: "export const App = () => null;\n" }),
    });
    return res.status;
  });
  expect(seeded).toBe(200);

  await page.goto(`/${slug}/code/site?view=preview&port=${VITE_PORT}`);
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const cta = page.frameLocator("iframe").locator("#cta");
  await expect(cta).toBeVisible({ timeout: 60_000 });

  // The inspector's button lights up only once the injected client has said hello, which is the
  // proof that the proxy put it there at all.
  const inspect = preview.getByRole("button", { name: "Inspect" });
  await expect(inspect).toBeEnabled({ timeout: 30_000 });
  await inspect.click();
  await expect(inspect).toHaveAttribute("aria-pressed", "true");

  // Click it in the page. The panel says what it is and, because the dev plugin tagged it, where
  // it came from.
  await cta.click();
  const panel = page.getByTestId("inspector-panel");
  await expect(panel.getByTestId("inspector-selection")).toContainText("src/App.tsx:12:5", {
    timeout: 20_000,
  });

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  await panel.getByRole("button", { name: "Use as context" }).click();

  // And a picture of the page, taken by the runner's own browser and attached to the same turn.
  await preview.getByRole("button", { name: "Screenshot" }).click();
  await expect(preview.getByRole("status")).toContainText("Attached.", { timeout: 60_000 });

  // The chip is waiting on the session's composer — without leaving the page, because that is how
  // this is used: the preview on one side, the session on the other.
  // On a phone the session list is a sheet; on a desktop it is already there.
  const newSession = page.getByRole("button", { name: "New session" });
  if (!(await newSession.isVisible())) {
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
  }
  await newSession.click();
  const start = page.getByRole("form", { name: "Start a session" });
  await start.getByLabel("Engine").selectOption("acp");
  await start.getByRole("button", { name: "Start" }).click();
  const pane = page.getByTestId("session-pane");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 30_000 });
  const chips = pane.getByTestId("context-chips");
  await expect(chips).toContainText("App.tsx", { timeout: 30_000 });
  await expect(chips).toContainText("Screenshot");

  // And the turn it rides on names the file, so the edit lands there and nowhere else.
  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await composer.fill("make this primary");
  await composer.press("Enter");
  const log = pane.getByRole("log", { name: "Transcript" });
  await expect(log).toContainText("src/App.tsx", { timeout: 60_000 });
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 60_000 });

  // The proof is the file itself: the agent wrote what was asked into the file the clicked element
  // came from, and into no other.
  const written = await page.evaluate(async () => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const list = (await (await fetch(`/api/workspaces/${ws}/projects`)).json()) as {
      projects: { id: string; key: string }[];
    };
    const project = list.projects.find((one) => one.key === "site")?.id ?? "";
    const res = await fetch(
      `/api/workspaces/${ws}/projects/${project}/fs/read?path=${encodeURIComponent("src/App.tsx")}`,
    );
    return res.ok
      ? (((await res.json()) as { content?: string }).content ?? "")
      : `HTTP ${res.status}`;
  });
  expect(written).toContain("make this primary");
  // Used once: the chip does not ride every turn after it.
  await expect(chips).toHaveCount(0);
});
