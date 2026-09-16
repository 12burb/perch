import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Phase 1's exit criterion, as one spec (task 1.22; spec §2 "Phase 1 … Exit"):
 *
 *   clone via GitHub → ask for a change → watch it in Preview from a phone → review the diff →
 *   commit → pull request
 *
 * It runs four times, once per Playwright project: on a paid key, on Ollama, through OpenCode, and
 * through ACP. Every lane drives the same screens; what changes is the credential the brain runs on
 * and the engine the session opens. The viewport is a phone's, because that is the one the
 * criterion names and the harder of the two.
 *
 * Nothing leaves this machine. scripts/e2e-server.ts stands up the GitHub each lane clones from and
 * opens its pull request on, the provider the key and the endpoint answer from, the dev server the
 * Preview tab watches, and — for the OpenCode lane — a stand-in `opencode serve` on the adapter's
 * own `baseUrl` seam (ADR-0089).
 */

type Origin = { url: string; repoUrl: string; token: string; login: string };
type Manifest = {
  github: Record<string, Origin>;
  opencode: { url: string };
  provider: { url: string };
  vite: { port: number; dir: string };
};

/** Where the harness left the addresses of everything it started. Read per test, not per import. */
function manifest(): Manifest {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

type Lane = {
  /** The engine the session runs on. */
  engine: "acp" | "opencode";
  /** The credential a brain is made from, when the lane is about one. */
  credential: null | { provider: "openai" | "ollama"; label: string; key: string; path: string };
  /** The model the brain names, out of the provider's own catalog. */
  model: string;
  /** What to ask for, and the words that come back when the change has landed. */
  prompt: string;
  wrote: string;
  /**
   * What the agent says it was started with, when the engine is one that can be asked. Names only,
   * never values (AGENTS.md §1.6) — and it is what makes the lanes visibly different: a key, an
   * endpoint, and an engine on its own configuration each hand the agent something else.
   */
  env: string | null;
};

const LANES: Record<string, Lane> = {
  // A key, the way anyone on a paid plan arrives: a credential of kind api_key against an
  // OpenAI-shaped endpoint, which is the path a real key takes (ADR-0089).
  key: {
    engine: "acp",
    credential: {
      provider: "openai",
      label: "Paid key",
      key: "sk-test-00000000phase1",
      path: "/key/v1",
    },
    model: "gpt-test-mini",
    prompt: "edit the notes",
    wrote: "written by the agent",
    env: "env: OPENAI_API_KEY, OPENAI_BASE_URL",
  },
  // An endpoint with no key at all, the way a laptop's Ollama arrives.
  ollama: {
    engine: "acp",
    credential: { provider: "ollama", label: "Ollama", key: "", path: "/v1" },
    model: "llama-test",
    prompt: "edit the notes",
    wrote: "written by the agent",
    env: "env: OLLAMA_HOST",
  },
  opencode: {
    engine: "opencode",
    credential: {
      provider: "openai",
      label: "Paid key",
      key: "sk-test-00000000phase1",
      path: "/key/v1",
    },
    model: "gpt-test-mini",
    // OpenCode asks before it edits when the turn starts with "ask".
    prompt: "ask to edit the notes",
    wrote: "written by opencode",
    // OpenCode is handed the same variables, but it is a server rather than an agent to ask.
    env: null,
  },
  // The engine on its own configuration: no credential and no brain, which is what a self-hoster
  // with an agent already logged in on the machine has.
  acp: {
    engine: "acp",
    credential: null,
    model: "",
    prompt: "edit the notes",
    wrote: "written by the agent",
    env: "env: none",
  },
};

test("clone, ask, watch from a phone, review, commit, pull request", async ({ page }, info) => {
  test.setTimeout(300_000);
  const laneId = String((info.project.metadata as { lane?: string }).lane ?? "acp");
  const lane = LANES[laneId];
  if (!lane) throw new Error(`no lane named ${laneId}`);
  const world = manifest();
  const origin = world.github[laneId];
  if (!origin) throw new Error(`the harness started no GitHub for ${laneId}`);
  // Its own branch, so main in the origin stays as it was cloned and a re-run starts clean.
  const branch = `perch/phase1-${laneId}-${Date.now()}`;

  await signUp(page, "Phase One", uniqueEmail(`phase1-${laneId}`));
  const slug = await createWorkspace(page, `Phase ${laneId}`);

  // ── The brain this lane runs on, and the service it clones from ──────────────────────────────
  await page.goto(`/${slug}/settings`);
  if (lane.credential) {
    const brains = page.getByRole("region", { name: "Brains" });
    const addCredential = brains.getByRole("form", { name: "Add credential" });
    await addCredential.getByLabel("Provider").selectOption(lane.credential.provider);
    await addCredential.getByLabel("Label").fill(lane.credential.label);
    if (lane.credential.key) await addCredential.getByLabel("API key").fill(lane.credential.key);
    await addCredential.getByLabel("Base URL").fill(`${world.provider.url}${lane.credential.path}`);
    await addCredential.getByRole("button", { name: "Save credential" }).click();
    const row = brains.getByRole("listitem").filter({ hasText: lane.credential.label });
    await expect(row).toBeVisible();
    // The secret went in and does not come back out (AGENTS.md §1.6).
    if (lane.credential.key) await expect(row).not.toContainText(lane.credential.key);

    const addBrain = brains.getByRole("form", { name: "Add brain" });
    await addBrain.getByLabel("Name", { exact: true }).fill("Phase brain");
    await addBrain.getByLabel("Credential").selectOption({ label: lane.credential.label });
    await addBrain.getByLabel("Model", { exact: true }).fill(lane.model);
    await addBrain.getByLabel("Default for").selectOption({ label: "Code" });
    await addBrain.getByRole("button", { name: "Add brain" }).click();
    await expect(brains.getByRole("listitem").filter({ hasText: "Phase brain" })).toContainText(
      "Default for Code",
    );
  }

  // A pasted token against a GitHub this workspace hosts itself: the API base field is the one a
  // GitHub Enterprise needs, and what points this run at the stand-in.
  const connections = page.getByRole("region", { name: "Connections" });
  const connect = connections.getByRole("form", { name: "Connect" });
  await connect.getByLabel("Service").selectOption("github");
  await connect.getByLabel("How to connect").selectOption("token");
  await connect.getByLabel("Token", { exact: true }).fill(origin.token);
  await connect.getByLabel("API base (optional)").fill(origin.url);
  await connect.getByRole("button", { name: "Connect" }).click();
  const connection = connections.getByRole("listitem").filter({ hasText: origin.login });
  await expect(connection).toBeVisible({ timeout: 30_000 });
  await expect(connection).not.toContainText(origin.token);

  // ── Clone via GitHub ─────────────────────────────────────────────────────────────────────────
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Nest");
  await page.getByRole("radio", { name: "Clone a repository" }).check();
  await page.getByLabel("Repository URL").fill(origin.repoUrl);
  await page.getByLabel("Authentication").selectOption("connection");
  // The first real option; the one before it is the "choose one" placeholder.
  await page.getByLabel("Connection").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create project" }).click();
  const projectRow = page.getByTestId("project-row").filter({ hasText: "Nest" });
  await expect(projectRow.getByTestId("project-status")).toHaveText("Ready", { timeout: 120_000 });
  await page.getByRole("link", { name: "Open Nest" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nest" })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;

  // ── Ask for a change ─────────────────────────────────────────────────────────────────────────
  const pane = page.getByTestId("session-pane");
  const newSession = page.getByRole("button", { name: "New session" });
  if (!(await newSession.isVisible())) {
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
  }
  await newSession.click();
  const form = page.getByRole("form", { name: "Start a session" });
  await form.getByLabel("Engine").selectOption(lane.engine);
  if (lane.credential) await form.getByLabel("Brain").selectOption({ label: "Phase brain" });
  await form.getByRole("button", { name: "Start" }).click();
  await expect(pane).toBeVisible({ timeout: 30_000 });
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 30_000 });

  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  const log = pane.getByRole("log", { name: "Transcript" });

  // The brain reached the engine: the agent names the variables it was started with, and this is
  // the one turn that differs between a paid key, an endpoint, and no credential at all.
  if (lane.env) {
    await composer.fill("env?");
    await composer.press("Enter");
    await expect(log.getByTestId("transcript-text").last()).toHaveText(lane.env, {
      timeout: 60_000,
    });
    await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 60_000 });
  }

  await composer.fill(lane.prompt);
  await composer.press("Enter");

  // It asks before it writes, on either engine, and the answer is one tap.
  const permission = page.getByRole("region", { name: "Permission for Edit notes.txt" });
  await expect(permission).toBeVisible({ timeout: 90_000 });
  await expect(pane.getByTestId("session-status")).toHaveText("Needs you");
  await permission.getByRole("button", { name: "Allow once" }).click();
  await expect(permission).toContainText("Allowed once");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 90_000 });

  // ── Review the diff ──────────────────────────────────────────────────────────────────────────
  await pane.getByRole("tab", { name: "Changes" }).click();
  const changes = pane.getByRole("region", { name: "Changes" });
  await expect(changes.getByRole("heading", { level: 3 })).toHaveText(["notes.txt"], {
    timeout: 60_000,
  });
  await expect(changes).toContainText(lane.wrote);
  await pane.getByRole("button", { name: "Close session pane" }).click();

  // ── Watch it in Preview, from a phone ────────────────────────────────────────────────────────
  await page.goto(`${projectPath}?view=preview&port=${world.vite.port}`);
  const preview = page.getByRole("region", { name: "Preview", exact: true });
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(preview.locator("iframe")).toHaveAttribute(
    "src",
    new RegExp(`^http://${world.vite.port}--${slug}\\.`),
  );
  await expect(page.frameLocator("iframe").locator("#app")).toHaveText(/^version (one|two)$/, {
    timeout: 60_000,
  });
  // The button that puts the editor back sits above the pane, beside the Preview heading.
  await page.getByRole("button", { name: "Back to the editor" }).click();

  // ── Branch, and commit ───────────────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Toggle drawer" }).click();
  await page.getByRole("tab", { name: "Git" }).click();
  const git = page.getByRole("region", { name: "Git" });
  await expect(git.getByRole("list", { name: "Changes" })).toContainText("notes.txt", {
    timeout: 60_000,
  });
  await git.getByLabel("New branch", { exact: true }).fill(branch);
  await git.getByRole("button", { name: "Create" }).click();
  await expect(git.getByLabel("Branch", { exact: true })).toHaveValue(branch, { timeout: 60_000 });

  await git.getByRole("button", { name: "Write it for me" }).click();
  const message = git.getByRole("textbox", { name: "Commit message" });
  await expect(message).not.toHaveValue("", { timeout: 90_000 });
  await git.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(git.getByTestId("git-note")).toContainText("Committed", { timeout: 60_000 });

  // ── Push, and open the pull request ──────────────────────────────────────────────────────────
  await git.getByLabel("Connection").selectOption({ index: 1 });
  await git.getByRole("button", { name: "Push" }).click();
  await expect(git.getByTestId("git-note")).toContainText("Pushed", { timeout: 90_000 });
  await git.getByLabel("Pull request title").fill(`Phase 1 on ${laneId}`);
  await git.getByRole("button", { name: "Open PR" }).click();
  await expect(git.getByTestId("git-note")).toContainText("Opened #7", { timeout: 60_000 });
});
