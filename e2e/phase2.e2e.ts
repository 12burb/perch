import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { createWorkspace, PASSWORD, secondBrowser, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Phase 2's exit criterion, as one spec (task 2.21; spec §2 "Phase 2 … Exit"):
 *
 *   a team of three uses it daily; @grok answers in #general; a Vercel deploy posts its preview URL
 *   in a thread; clicking a button in Preview and typing "make this primary" lands the right edit;
 *   a permission is approved from the phone inbox; a channel pinned to local models refuses a cloud
 *   model; three bots complete a fan-out and a ping-pong pair trips the breaker.
 *
 * Each clause has its own spec already. What this adds is the sentence: one workspace, one
 * afternoon, three people in three browsers — Ada who set it up, Grace on a laptop and then a
 * phone, and Linus in the IDE — with the axe sweep §11 asks for on Home, Code and Inbox as each
 * one is reached, at the viewport that person is using.
 *
 * Nothing leaves this machine: scripts/e2e-server.ts stands up the model provider, the Vercel and
 * Supabase stand-ins, and the dev server Preview watches.
 */

const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? "3997");

type World = {
  provider: { url: string };
  vercel: { url: string; token: string };
};

function world(): World {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as World;
}

/** No violations, said in a way that names them when there are. */
async function sweep(page: Page, where: string): Promise<void> {
  const scan = await new AxeBuilder({ page }).include("main").analyze();
  expect(scan.violations.map((v) => `${where} — ${v.id}: ${v.help}`)).toEqual([]);
}

const POLICY = `version: 1
git:
  protectedBranches: [main]
commands:
  deny: ["git push --force"]
models:
  channels:
    local-only:
      allow: ["ollama/*"]
`;

test("a team of three uses Perch for an afternoon", async ({ page, browser }) => {
  test.setTimeout(600_000);
  const stand = world();
  const graceEmail = uniqueEmail("grace");
  const linusEmail = uniqueEmail("linus");

  // ---------------------------------------------------------------- Ada sets the nest up
  await signUp(page, "Ada", uniqueEmail("ada"));
  const slug = await createWorkspace(page, "Nest");

  for (const name of ["general", "ship", "local-only"]) {
    const form = page.getByRole("form", { name: "Start a channel" });
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByRole("button", { name: "Create channel" }).click();
    await expect(page.getByRole("region", { name: `#${name}` })).toBeVisible({ timeout: 30_000 });
    await page.goto(`/${slug}/home`);
  }

  // A brain everything runs on, the two connections the Deploy button needs, and the bots: @grok
  // who answers in #general, the desk that fans out, and the pair that will argue.
  const ids = await page.evaluate(
    async (input) => {
      const post = async (path: string, body: unknown) => {
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const mine = (await (await fetch("/api/workspaces")).json()) as {
        workspaces: { id: string }[];
      };
      const ws = mine.workspaces[0]?.id ?? "";
      const channels = (await (await fetch(`/api/workspaces/${ws}/channels`)).json()) as {
        channels: { id: string; name: string | null }[];
      };
      const idOf = (name: string) => channels.channels.find((one) => one.name === name)?.id ?? "";
      const credential = await post(`/api/workspaces/${ws}/credentials`, {
        provider: "custom",
        kind: "endpoint",
        scope: "workspace",
        label: "Stand-in",
        base_url: `${input.providerUrl}/v1`,
      });
      await post(`/api/workspaces/${ws}/model-profiles`, {
        name: "Nest brain",
        provider: "custom",
        model_id: "gpt-test-mini",
        credential_id: credential.body.id,
        default_for: "chat",
      });
      await post(`/api/workspaces/${ws}/connections`, {
        kind: "token",
        provider: "vercel",
        token: input.vercelToken,
        owner_type: "workspace",
        api_base: input.vercelUrl,
      });
      const general = idOf("general");
      for (const [handle, name, where] of [
        ["grok", "Grok", general],
        ["desk", "Desk", general],
        ["crypto", "Crypto", general],
        ["gaming", "Gaming", general],
        ["ping", "Ping", general],
        ["pong", "Pong", general],
        ["scribe", "Scribe", idOf("local-only")],
      ] as const) {
        const bot = await post(`/api/workspaces/${ws}/bots`, {
          handle,
          name,
          visibility: "workspace",
          budget: { dailyUsd: 5, perThreadUsd: 1 },
          spec: {
            persona: `You are ${name}.`,
            brain: { profile: "Nest brain" },
            triggers: [{ on: "mention" }],
            tools: [],
          },
        });
        await post(`/api/workspaces/${ws}/bots/${String(bot.body.id)}/install`, {
          channel_id: where,
        });
      }
      const project = await post(`/api/workspaces/${ws}/projects`, {
        name: "Site",
        key: "site",
        source: "empty",
      });
      const invite = async (email: string) =>
        (
          (await post(`/api/workspaces/${ws}/invites`, { email, role: "member" })).body as {
            accept_url: string;
          }
        ).accept_url;
      return {
        workspaceId: ws,
        general,
        ship: idOf("ship"),
        localOnly: idOf("local-only"),
        projectId: String(project.body.id ?? ""),
        graceInvite: await invite(input.graceEmail),
        linusInvite: await invite(input.linusEmail),
      };
    },
    {
      providerUrl: stand.provider.url,
      vercelUrl: stand.vercel.url,
      vercelToken: stand.vercel.token,
      graceEmail,
      linusEmail,
    },
  );
  expect(ids.projectId).not.toBe("");

  // The policy that pins one channel to local models, written where the workspace is settled.
  await page.goto(`/${slug}/settings`);
  const document = page.getByRole("form", { name: "The policy" });
  await expect(document).toBeVisible({ timeout: 30_000 });
  await document.getByLabel("The policy").fill(POLICY);
  await document.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByTestId("policy-saved")).toBeVisible({ timeout: 30_000 });

  await page.goto(`/${slug}/home`);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await sweep(page, "Home");

  // ---------------------------------------------------------------- @grok answers in #general
  await page.goto(`/${slug}/home/${ids.general}`);
  const composer = page.getByRole("textbox", { name: "Say something in #general" });
  await composer.fill("@grok what is the news?");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages in #general" });
  const askedGrok = flow.getByTestId("message").filter({ hasText: "what is the news?" });
  await expect(askedGrok.getByTestId("reply-count")).toBeVisible({ timeout: 90_000 });
  await askedGrok.getByTestId("reply-count").click();
  const thread = page.getByRole("region", { name: "Thread" });
  const grokAnswer = thread.getByTestId("message").filter({ hasText: "Reading you" });
  await expect(grokAnswer).toBeVisible({ timeout: 90_000 });
  await expect(grokAnswer.getByText("Grok", { exact: true })).toBeVisible();

  // ---------------------------------------------------------------- three bots fan out
  await composer.fill("@desk put together today's headlines");
  await composer.press("Enter");
  const askedDesk = flow.getByTestId("message").filter({ hasText: "today's headlines" });
  await expect(askedDesk.getByTestId("reply-count")).toBeVisible({ timeout: 90_000 });
  await askedDesk.getByTestId("reply-count").click();
  await expect(thread.getByTestId("message").filter({ hasText: "crypto piece" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(thread.getByTestId("message").filter({ hasText: "gaming piece" })).toBeVisible({
    timeout: 90_000,
  });
  // Three hops on one chain: the person's tag, and the desk's two.
  const header = thread.getByTestId("chain-header");
  await expect(header).toContainText("3 hops", { timeout: 60_000 });
  await expect(header).toContainText("Crypto");
  await expect(header).toContainText("Gaming");

  // ---------------------------------------------------------------- and a pair trips the breaker
  await composer.fill("@ping start the argument");
  await composer.press("Enter");
  const askedPing = flow.getByTestId("message").filter({ hasText: "start the argument" });
  await expect(askedPing.getByTestId("reply-count")).toBeVisible({ timeout: 90_000 });
  await askedPing.getByTestId("reply-count").click();
  // The thread stops itself and asks a person, in a card made of the same blocks a bot posts.
  await expect(thread.getByTestId("message").filter({ hasText: "paused" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(thread.getByTestId("chain-header")).toContainText("back and forth", {
    timeout: 60_000,
  });

  // ---------------------------------------------------------------- Grace joins, on a laptop
  const grace = await secondBrowser(browser);
  await grace.goto(new URL(ids.graceInvite).pathname + new URL(ids.graceInvite).search);
  await grace.getByRole("link", { name: "Create an account to accept" }).click();
  await grace.getByLabel("Name").fill("Grace");
  await grace.getByLabel("Email").fill(graceEmail);
  await grace.getByLabel("Password").fill(PASSWORD);
  await grace.getByRole("button", { name: "Create account" }).click();
  await grace.getByRole("button", { name: "Accept invite" }).click();
  await expect(grace).toHaveURL(new RegExp(`/${slug}/home$`));

  // ------------------------------------------ the channel pinned to local models refuses a brain
  await grace.goto(`/${slug}/home`);
  const localRow = grace.getByTestId("channel-row").filter({ hasText: "local-only" });
  await expect(localRow).toBeVisible({ timeout: 30_000 });
  await localRow.getByRole("button", { name: "Join" }).click();
  await localRow.getByRole("link", { name: "Open local-only" }).click();
  const graceComposer = grace.getByRole("textbox", { name: "Say something in #local-only" });
  await graceComposer.fill("@scribe what is the plan?");
  await graceComposer.press("Enter");
  const graceFlow = grace.getByRole("log", { name: "Messages in #local-only" });
  const askedScribe = graceFlow.getByTestId("message").filter({ hasText: "what is the plan?" });
  await expect(askedScribe.getByTestId("reply-count")).toBeVisible({ timeout: 90_000 });
  await askedScribe.getByTestId("reply-count").click();
  await expect(
    grace.getByRole("region", { name: "Thread" }).getByTestId("message").last(),
  ).toContainText("list of models", { timeout: 90_000 });

  // ---------------------------------------------------------------- Ada ships it
  await page.goto(`/${slug}/code/site`);
  await expect(page.getByRole("heading", { level: 1, name: "Site" })).toBeVisible({
    timeout: 60_000,
  });
  await sweep(page, "Code");
  const openDrawer = async (name: string) => {
    const tab = page.getByRole("tab", { name, exact: true });
    if (!(await tab.isVisible())) await page.getByRole("button", { name: "Toggle drawer" }).click();
    await tab.click();
  };
  await openDrawer("Deploy");
  const deploy = page.getByRole("region", { name: "Deploy" });
  await expect(deploy).toBeVisible();
  await deploy.getByLabel("Repository URL").fill("https://github.com/perch/site.git");
  await deploy.getByRole("button", { name: "Save" }).click();
  await expect(deploy.getByLabel("Announce in")).toBeVisible({ timeout: 30_000 });
  await deploy.getByLabel("Announce in").selectOption({ label: "#ship" });
  await deploy.getByRole("button", { name: "Deploy", exact: true }).click();
  const deployment = page.getByTestId("deployment");
  await expect(deployment).toContainText("Building", { timeout: 30_000 });
  // The panel is what keeps asking, so it stays open until the provider has a URL.
  await expect(deployment.getByRole("link")).toHaveText(/vercel\.test/, { timeout: 90_000 });

  // The card in #ship is the deploy: posted while it was still building, rewritten with the URL.
  await page.goto(`/${slug}/home/${ids.ship}`);
  const card = page.getByTestId("deploy-card");
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card).toContainText("Ready", { timeout: 90_000 });
  await expect(card.getByRole("link").first()).toHaveText(/vercel\.test/);

  // ------------------------------------------- Linus points at the page and asks for a change
  const linus = await secondBrowser(browser);
  await linus.goto(new URL(ids.linusInvite).pathname + new URL(ids.linusInvite).search);
  await linus.getByRole("link", { name: "Create an account to accept" }).click();
  await linus.getByLabel("Name").fill("Linus");
  await linus.getByLabel("Email").fill(linusEmail);
  await linus.getByLabel("Password").fill(PASSWORD);
  await linus.getByRole("button", { name: "Create account" }).click();
  await linus.getByRole("button", { name: "Accept invite" }).click();

  const seeded = await linus.evaluate(async (workspaceId: string) => {
    const list = (await (await fetch(`/api/workspaces/${workspaceId}/projects`)).json()) as {
      projects: { id: string; key: string }[];
    };
    const project = list.projects.find((one) => one.key === "site")?.id ?? "";
    const res = await fetch(`/api/workspaces/${workspaceId}/projects/${project}/fs/write`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/App.tsx", content: "export const App = () => null;\n" }),
    });
    return res.status;
  }, ids.workspaceId);
  expect(seeded).toBe(200);

  await linus.goto(`/${slug}/code/site?view=preview&port=${VITE_PORT}`);
  const preview = linus.getByRole("region", { name: "Preview" });
  await expect(preview).toBeVisible({ timeout: 60_000 });
  const cta = linus.frameLocator("iframe").locator("#cta");
  await expect(cta).toBeVisible({ timeout: 90_000 });
  const inspect = preview.getByRole("button", { name: "Inspect" });
  await expect(inspect).toBeEnabled({ timeout: 60_000 });
  await inspect.click();
  await cta.click();
  const panel = linus.getByTestId("inspector-panel");
  await expect(panel.getByTestId("inspector-selection")).toContainText("src/App.tsx", {
    timeout: 30_000,
  });
  await panel.getByRole("button", { name: "Use as context" }).click();

  const newSession = linus.getByRole("button", { name: "New session" });
  if (!(await newSession.isVisible())) {
    await linus.getByRole("button", { name: "Toggle sidebar" }).click();
  }
  await newSession.click();
  const start = linus.getByRole("form", { name: "Start a session" });
  await start.getByLabel("Engine").selectOption("acp");
  await start.getByRole("button", { name: "Start" }).click();
  const pane = linus.getByTestId("session-pane");
  await expect(pane.getByTestId("session-status")).toHaveText("Idle", { timeout: 60_000 });
  await expect(pane.getByTestId("context-chips")).toContainText("App.tsx", { timeout: 30_000 });

  const askAgent = pane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await askAgent.fill("make this primary");
  await askAgent.press("Enter");
  await expect(pane.getByRole("log", { name: "Transcript" })).toContainText("src/App.tsx", {
    timeout: 90_000,
  });
  const written = await linus.evaluate(async (workspaceId: string) => {
    const list = (await (await fetch(`/api/workspaces/${workspaceId}/projects`)).json()) as {
      projects: { id: string; key: string }[];
    };
    const project = list.projects.find((one) => one.key === "site")?.id ?? "";
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${project}/fs/read?path=${encodeURIComponent("src/App.tsx")}`,
    );
    return res.ok
      ? (((await res.json()) as { content?: string }).content ?? "")
      : `HTTP ${res.status}`;
  }, ids.workspaceId);
  expect(written).toContain("make this primary");

  // ------------------------------------------- Grace approves a permission from her phone
  // A session of her own, asking for something it has to ask about.
  await grace.goto(`/${slug}/code/site`);
  await expect(grace.getByRole("heading", { level: 1, name: "Site" })).toBeVisible({
    timeout: 60_000,
  });
  const graceNew = grace.getByRole("button", { name: "New session" });
  if (!(await graceNew.isVisible())) {
    await grace.getByRole("button", { name: "Toggle sidebar" }).click();
  }
  await graceNew.click();
  const graceStart = grace.getByRole("form", { name: "Start a session" });
  await graceStart.getByLabel("Engine").selectOption("acp");
  await graceStart.getByRole("button", { name: "Start" }).click();
  const gracePane = grace.getByTestId("session-pane");
  await expect(gracePane.getByTestId("session-status")).toHaveText("Idle", { timeout: 60_000 });
  await gracePane.getByRole("radio", { name: "Build" }).check({ force: true });
  const graceAsk = gracePane
    .getByRole("form", { name: "Message the agent" })
    .getByRole("textbox", { name: "Ask the agent…" });
  await graceAsk.fill("edit the notes");
  await graceAsk.press("Enter");
  await expect(gracePane.getByTestId("session-status")).toHaveText("Needs you", {
    timeout: 60_000,
  });

  // She picks up her phone. Same account, a 390 px viewport — where Inbox is the launch tab.
  const phoneContext = await browser.newContext({
    storageState: await grace.context().storageState(),
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await phoneContext.newPage();
  await phone.goto("/");
  await expect(phone).toHaveURL(new RegExp(`/${slug}/inbox`), { timeout: 60_000 });
  const inbox = phone.getByTestId("inbox");
  const item = inbox.getByTestId("inbox-item").filter({ hasText: "Edit notes.txt" });
  await expect(item).toBeVisible({ timeout: 60_000 });
  await sweep(phone, "Inbox");
  await item.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(inbox.getByTestId("inbox-item")).toHaveCount(0, { timeout: 60_000 });

  // The session she never reopened carried on without her.
  await expect
    .poll(
      async () => await gracePane.getByTestId("session-status").textContent({ timeout: 10_000 }),
      { timeout: 60_000 },
    )
    .not.toBe("Needs you");

  await phoneContext.close();
  await linus.context().close();
  await grace.context().close();
});
