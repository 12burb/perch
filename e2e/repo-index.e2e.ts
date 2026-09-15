import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.17 (spec §5.7, §11): repo intelligence. The acceptance §11 names is "an @codebase question
 * cites the right file", and this spec does it the way a person would: index the project from the
 * Codebase drawer, ask the index a question there, follow a hit into the editor, and then ask the
 * agent the same question with `@codebase` and watch it answer with the file.
 *
 * The brain that embeds is the stand-in provider scripts/e2e-server.ts starts, reached through a
 * credential's base URL the way a self-hosted install reaches Ollama.
 */

const PROVIDER = `http://127.0.0.1:${process.env.E2E_PROVIDER_PORT ?? "3998"}`;

test("the codebase index answers, and @codebase cites the right file", async ({ page }, info) => {
  test.setTimeout(240_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Index Owner", uniqueEmail("index"));
  const slug = await createWorkspace(page, "Index Nest");
  await page.goto(`/${slug}/code`);

  // A project with two files in it, and a brain to embed with. Written over the same routes the
  // editor and the Brains page use, because what this spec is about is what comes after.
  const projectId: string = await page.evaluate(async (providerUrl) => {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const project = await post(`/api/workspaces/${ws}/projects`, {
      name: "Nest",
      key: "nest",
      source: "empty",
    });
    const id = String(project.id ?? "");
    const credential = await post(`/api/workspaces/${ws}/credentials`, {
      provider: "ollama",
      kind: "endpoint",
      scope: "workspace",
      label: "Stand-in embedder",
      base_url: `${providerUrl}/v1`,
    });
    await post(`/api/workspaces/${ws}/model-profiles`, {
      name: "Nest Embedder",
      provider: "ollama",
      model_id: "embed-test",
      credential_id: String(credential.id ?? ""),
      default_for: "embedding",
    });

    // The project directory has to be ready before anything can be written into it.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const row = (await (await fetch(`/api/workspaces/${ws}/projects/${id}`)).json()) as {
        status?: string;
      };
      if (row.status === "ready") break;
      if (Date.now() > deadline) throw new Error(`project stayed ${row.status}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const write = (path: string, content: string) =>
      fetch(`/api/workspaces/${ws}/projects/${id}/fs/write`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
    await write(
      "src/retry.ts",
      "/** How many times a failed delivery is tried again. */\nexport const RETRY_BUDGET = 5;\n",
    );
    await write(
      "src/presence.ts",
      "export type Presence = { userId: string; lastSeen: number };\n",
    );
    return id;
  }, PROVIDER);
  expect(projectId).not.toBe("");

  const row = page.getByTestId("project-row").filter({ hasText: "Nest" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 90_000 });
  await page.goto(`/${slug}/code/nest`);
  await expect(page.getByRole("heading", { level: 1, name: "Nest" })).toBeVisible();

  // The Codebase drawer. (The drawer remembers whether it was open, so it is asked for only when
  // its tabs are not already there.)
  const openDrawer = async (name: string) => {
    const tab = page.getByRole("tab", { name, exact: true });
    if (!(await tab.isVisible())) {
      await page.getByRole("button", { name: "Toggle drawer" }).click();
    }
    await tab.click();
  };
  await openDrawer("Codebase");
  const panel = page.getByRole("region", { name: "Codebase" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Not indexed")).toBeVisible();

  await panel.getByRole("button", { name: "Index now" }).click();
  await expect(panel.getByText("2 files")).toBeVisible({ timeout: 60_000 });
  // The workspace named an embedding brain, so the index has vectors as well as words.
  await expect(panel.getByText("Meaning too, via Nest Embedder")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // Asking the index, and following what it says into the editor.
  await panel.getByLabel("Question").fill("retry budget");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const hits = panel.getByRole("list", { name: "What the index knows" });
  await expect(hits.getByRole("button").first()).toContainText("src/retry.ts", { timeout: 30_000 });
  await hits.getByRole("button").first().click();
  await expect(page.getByRole("tab", { name: /retry\.ts/ })).toBeVisible({ timeout: 30_000 });

  // The acceptance: the same question in a session, with @codebase, and the agent answers with the
  // file — which it can only do because Perch put the file in front of it. Sessions live in the
  // sidebar, which is a sheet on a phone.
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.getByRole("form", { name: "Start a session" });
  await form.getByLabel("Engine").selectOption("acp");
  await form.getByRole("button", { name: "Start" }).click();
  const pane = page.getByTestId("session-pane");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 60_000 });
  const composer = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await composer.fill("@codebase where is the retry budget?");
  await composer.press("Enter");
  const transcript = pane.getByRole("log", { name: "Transcript" });
  await expect(transcript).toContainText("cited: src/retry.ts", { timeout: 90_000 });
  // …and what the person said is still what the person said: no context block in the transcript.
  await expect(transcript.getByTestId("transcript-turn").first()).toContainText(
    "@codebase where is the retry budget?",
  );
  await expect(transcript).not.toContainText("From this project's index");

  // The same index, from the search page's Code lane.
  await page.goto(`/${slug}/search`);
  await page
    .getByRole("form", { name: "Search" })
    .getByLabel("What are you looking for")
    .fill("RETRY_BUDGET");
  await expect(page.getByTestId("code-hit").first()).toContainText("src/retry.ts", {
    timeout: 30_000,
  });

  await info.attach("codebase", { body: await page.screenshot(), contentType: "image/png" });
});
