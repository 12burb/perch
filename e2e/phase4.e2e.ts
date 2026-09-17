import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { record, within } from "../scripts/launch-bar.ts";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Phase 4's exit criterion, as one spec (task 4.13; spec §2 "Phase 4 … Exit"):
 *
 *   "public beta where compose and `curl | sh` work for strangers; time-to-first-agent-PR under
 *   ten minutes"
 *
 * The two ways in are proved where they run — the compose smoke and the laptop smoke, both in CI,
 * both timing their own leg of the launch bar (`scripts/launch-bar.ts`). What is left is the part
 * a stranger actually came for, and the only one that needs a browser: from arriving at a Perch
 * somebody else has already stood up to an agent's pull request being open, on a phone, with the
 * clock running.
 *
 * Nothing here is a shortcut. The workspace is made through the welcome screen, the connection is
 * pasted into the Connections card, the project is cloned through that connection, the change is
 * asked for in the composer and permitted in the prompt, and the pull request is opened from the
 * Git panel. What Phase 4 added is on the way: the Hub is where the stranger finds the thing to
 * install, and every screen they pass is swept by axe as they pass it.
 *
 * Nothing leaves this machine: scripts/e2e-server.ts stands up the GitHub this clones from and
 * opens its pull request on, and the ACP agent that makes the change.
 */

type World = { github: Record<string, { url: string; repoUrl: string; token: string }> };

function world(): World {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as World;
}

/** No violations, said in a way that names them when there are. */
async function sweep(page: Page, where: string): Promise<void> {
  const scan = await new AxeBuilder({ page })
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(scan.violations.map((one) => `${where} — ${one.id}: ${one.help}`)).toEqual([]);
}

test("a stranger arrives, and their first agent opens a pull request", async ({ page }) => {
  test.setTimeout(600_000);
  const origin = world().github.phase4;
  if (!origin) throw new Error("the harness started no GitHub for phase 4");
  const branch = `perch/phase4-${Date.now()}`;

  // ── The clock starts where a stranger's does: at the front door ───────────────────────────────
  const started = performance.now();
  await page.goto("/sign-up");
  await sweep(page, "sign-up");
  await signUp(page, "First Flight", uniqueEmail("phase4"));
  const slug = await createWorkspace(page, "First Nest");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible({
    timeout: 60_000,
  });

  // ── The Hub: what this Perch has, and one press to take some of it on (task 4.12) ─────────────
  await page.goto(`/${slug}/hub`);
  await expect(page.getByRole("heading", { level: 1, name: "Hub" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel("Search the Hub").fill("helpdesk");
  const hubCard = page.getByRole("list", { name: "Hub" }).getByRole("listitem").first();
  await expect(hubCard).toContainText("Helpdesk");
  await hubCard.getByRole("button", { name: /^Install/ }).click();
  await expect(hubCard.getByRole("status")).toContainText("is here", { timeout: 60_000 });
  await sweep(page, "hub");

  // ── The service the work lives on, connected with a pasted token ──────────────────────────────
  await page.goto(`/${slug}/settings`);
  const connections = page.getByRole("region", { name: "Connections" });
  const connect = connections.getByRole("form", { name: "Connect" });
  await connect.getByLabel("Service").selectOption("github");
  await connect.getByLabel("How to connect").selectOption("token");
  await connect.getByLabel("Token", { exact: true }).fill(origin.token);
  await connect.getByLabel("API base (optional)").fill(origin.url);
  await connect.getByRole("button", { name: "Connect" }).click();
  const connection = connections.getByRole("listitem").filter({ hasText: "GitHub" }).first();
  await expect(connection).toBeVisible({ timeout: 60_000 });
  // The token went in and does not come back out (AGENTS.md §1.6).
  await expect(connection).not.toContainText(origin.token);

  // ── A project, cloned through it ──────────────────────────────────────────────────────────────
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Firstflight");
  await page.getByRole("radio", { name: "Clone a repository" }).check();
  await page.getByLabel("Repository URL").fill(origin.repoUrl);
  await page.getByLabel("Authentication").selectOption("connection");
  await page.getByLabel("Connection").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Firstflight" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 180_000 });
  await page.getByRole("link", { name: "Open Firstflight" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Firstflight" })).toBeVisible();

  // ── Ask an agent for a change ─────────────────────────────────────────────────────────────────
  const pane = page.getByTestId("session-pane");
  const newSession = page.getByRole("button", { name: "New session" });
  if (!(await newSession.isVisible())) {
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
  }
  await newSession.click();
  const form = page.getByRole("form", { name: "Start a session" });
  await form.getByLabel("Engine").selectOption("acp");
  await form.getByRole("button", { name: "Start" }).click();
  await expect(pane).toBeVisible({ timeout: 60_000 });
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 60_000 });

  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await composer.fill("edit the notes");
  await composer.press("Enter");

  // It asks before it writes, and the answer is one tap.
  const permission = page.getByRole("region", { name: "Permission for Edit notes.txt" });
  await expect(permission).toBeVisible({ timeout: 120_000 });
  await permission.getByRole("button", { name: "Allow once" }).click();
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 120_000 });

  // ── Read what it did ──────────────────────────────────────────────────────────────────────────
  await pane.getByRole("tab", { name: "Changes" }).click();
  const changes = pane.getByRole("region", { name: "Changes" });
  await expect(changes.getByRole("heading", { level: 3 })).toHaveText(["notes.txt"], {
    timeout: 90_000,
  });
  await expect(changes).toContainText("written by the agent");
  await pane.getByRole("button", { name: "Close session pane" }).click();

  // ── Branch, commit, push, and open the pull request ───────────────────────────────────────────
  await page.getByRole("button", { name: "Toggle drawer" }).click();
  await page.getByRole("tab", { name: "Git" }).click();
  const git = page.getByRole("region", { name: "Git" });
  await expect(git.getByRole("list", { name: "Changes" })).toContainText("notes.txt", {
    timeout: 90_000,
  });
  await git.getByLabel("New branch", { exact: true }).fill(branch);
  await git.getByRole("button", { name: "Create" }).click();
  await expect(git.getByLabel("Branch", { exact: true })).toHaveValue(branch, { timeout: 60_000 });
  await git.getByRole("textbox", { name: "Commit message" }).fill("Write the notes");
  await git.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(git.getByTestId("git-note")).toContainText("Committed", { timeout: 60_000 });
  await git.getByLabel("Connection").selectOption({ index: 1 });
  await git.getByRole("button", { name: "Push" }).click();
  await expect(git.getByTestId("git-note")).toContainText("Pushed", { timeout: 120_000 });
  await git.getByLabel("Pull request title").fill("A stranger's first change");
  await git.getByRole("button", { name: "Open PR" }).click();
  await expect(git.getByTestId("git-note")).toContainText("Opened #", { timeout: 90_000 });

  // ── The clock stops here, and the number is the bar ───────────────────────────────────────────
  const took = performance.now() - started;
  record("first-agent-pr", took, resolve(process.cwd(), "test-results", "launch-bar.json"));
  within("first-agent-pr", took);
});
