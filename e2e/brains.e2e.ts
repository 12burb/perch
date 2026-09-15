import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.15 (spec §3.4, §3.6 lane A): an OpenAI key and an Ollama endpoint both run a session.
 *
 * Both credentials point at the stand-in provider scripts/e2e-server.ts serves on 3998: the key
 * one at a path that refuses an unauthenticated request, the endpoint one at a path that does not
 * ask. Each is added, tested against the provider's own model list, named as a brain, and used to
 * start a session — and the session's answer names the variables the engine was given, never a
 * value, because a key must not reach a model context (AGENTS.md §1.6).
 */

const PROVIDER = `http://127.0.0.1:${process.env.E2E_PROVIDER_PORT ?? "3998"}`;

test("a key and an endpoint each become a brain that runs a session", async ({ page }, info) => {
  test.setTimeout(180_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Brain Keeper", uniqueEmail("brains"));
  const slug = await createWorkspace(page, "Brain Nest");

  await page.goto(`/${slug}/settings`);
  const brains = page.getByRole("region", { name: "Brains" });
  await expect(brains.getByText("No credentials yet.", { exact: false })).toBeVisible();

  // A key: the provider refuses this path without an Authorization header, so listing models is
  // proof the key went out with the request.
  const addCredential = brains.getByRole("form", { name: "Add credential" });
  await addCredential.getByLabel("Provider").selectOption("openai");
  await addCredential.getByLabel("Label").fill("OpenAI test");
  await addCredential.getByLabel("API key").fill("sk-test-000000004f2a");
  await addCredential.getByLabel("Base URL").fill(`${PROVIDER}/key/v1`);
  await addCredential.getByRole("button", { name: "Save credential" }).click();

  const keyRow = brains.getByRole("listitem").filter({ hasText: "OpenAI test" });
  await expect(keyRow).toBeVisible();
  // The key is never shown again — only the hint the API answered with.
  await expect(keyRow).toContainText("sk…4f2a");
  await expect(keyRow).not.toContainText("sk-test-000000004f2a");

  // An endpoint: no key at all, the way a laptop's Ollama arrives.
  await addCredential.getByLabel("Provider").selectOption("ollama");
  await addCredential.getByLabel("Label").fill("Ollama test");
  await addCredential.getByLabel("Base URL").fill(`${PROVIDER}/v1`);
  await addCredential.getByRole("button", { name: "Save credential" }).click();
  const endpointRow = brains.getByRole("listitem").filter({ hasText: "Ollama test" });
  await expect(endpointRow).toBeVisible();

  // Test is the catalog call: both credentials reach the provider and list its two models.
  await keyRow.getByRole("button", { name: "Test OpenAI test" }).click();
  await expect(keyRow.getByRole("status")).toHaveText("2 models", { timeout: 20_000 });
  await endpointRow.getByRole("button", { name: "Test Ollama test" }).click();
  await expect(endpointRow.getByRole("status")).toHaveText("2 models", { timeout: 20_000 });

  // Two brains, one on each credential. The first is the workspace default for code.
  const addBrain = brains.getByRole("form", { name: "Add brain" });
  await addBrain.getByLabel("Name", { exact: true }).fill("Cloud");
  await addBrain.getByLabel("Credential").selectOption({ label: "OpenAI test" });
  await addBrain.getByLabel("Model", { exact: true }).fill("gpt-test-mini");
  await addBrain.getByLabel("Default for code").check();
  await addBrain.getByRole("button", { name: "Add brain" }).click();
  await expect(brains.getByRole("listitem").filter({ hasText: "Cloud" })).toContainText(
    "Default for code",
  );

  await addBrain.getByLabel("Name", { exact: true }).fill("Local");
  await addBrain.getByLabel("Credential").selectOption({ label: "Ollama test" });
  await addBrain.getByLabel("Model", { exact: true }).fill("llama-test");
  await addBrain.getByRole("button", { name: "Add brain" }).click();
  await expect(brains.getByRole("listitem").filter({ hasText: "Local" })).toBeVisible();

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);

  // A project to run them in.
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Brainy");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Brainy" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open Brainy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Brainy" })).toBeVisible();

  // On a phone the sidebar is a sheet: open it only when the Sessions section is not already up,
  // because a second toggle would close it again.
  const openSidebar = async () => {
    if (!mobile) return;
    const newSession = page.getByRole("button", { name: "New session" });
    if (await newSession.isVisible()) return;
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(newSession).toBeVisible();
  };
  const pane = page.getByTestId("session-pane");

  /** Starts a session on a named brain and asks it which provider variables it was given. */
  const askEnv = async (brain: string): Promise<void> => {
    // The phone's pane is a modal sheet over the sidebar, so the last session closes first.
    if (mobile && (await pane.isVisible())) {
      await pane.getByRole("button", { name: "Close session pane" }).click();
      await expect(pane).toBeHidden();
    }
    await openSidebar();
    await page.getByRole("button", { name: "New session" }).click();
    const form = page.getByRole("form", { name: "Start a session" });
    await form.getByLabel("Engine").selectOption("acp");
    await form.getByLabel("Brain").selectOption({ label: brain });
    await form.getByRole("button", { name: "Start" }).click();
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 20_000 });
    const composer = pane
      .getByRole("form", { name: "Message the agent" })
      .getByRole("textbox", { name: "Ask the agent…" });
    await composer.fill("env?");
    await composer.press("Enter");
  };

  const log = pane.getByRole("log", { name: "Transcript" });
  await askEnv("Cloud");
  await expect(log.getByTestId("transcript-text").last()).toHaveText(
    "env: OPENAI_API_KEY, OPENAI_BASE_URL",
    { timeout: 30_000 },
  );

  await askEnv("Local");
  await expect(log.getByTestId("transcript-text").last()).toHaveText("env: OLLAMA_HOST", {
    timeout: 30_000,
  });
});
