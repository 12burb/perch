import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Phase 3's exit criterion, as one spec (task 3.23; spec §2 "Phase 3 … Exit"):
 *
 *   "@dawn fix X" from chat ships a diff card and a PR; three agents work one repo in parallel
 *   without conflicts; a race picks a winner; a Nest agent posts via the Bot API using a granted
 *   Supabase connection; the agent screenshots its own change before reporting done.
 *
 * Each clause has its own api test already. What this adds is the sentence, in a browser: one
 * workspace, one repository, one afternoon — a mention that becomes a pull request, three agents
 * on the same repository at the same time, a race somebody judges, a Nest agent answering from a
 * connection it was granted, and a push that a page which does not load refuses to let through.
 *
 * The axe sweep §11 asks for lands where the work does: the board, the Pull Requests page, and a
 * thread with a session card.
 *
 * Nothing leaves this machine. scripts/e2e-server.ts stands up the GitHub this project is cloned
 * from and pushed to, the Supabase the Nest agent reads, the model behind the chat bots, the ACP
 * agent the sessions run on, and the dev server preflight looks at.
 *
 * Three branches landing in sequence is `apps/api/test/merge-queue.test.ts`: what belongs here is
 * that three agents can work at once without treading on each other, which is the worktree per
 * task (3.14) rather than the queue.
 */

type World = {
  github: Record<string, { url: string; repoUrl: string; token: string; login: string }>;
  provider: { url: string };
  supabase: { url: string; mcpUrl: string; token: string };
  vite: { port: number };
};

function world(): World {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as World;
}

/** No violations, said in a way that names them when there are. */
async function sweep(page: Page, where: string): Promise<void> {
  const scan = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(scan.violations.map((v) => `${where} — ${v.id}: ${v.help}`)).toEqual([]);
}

/** The api, from inside the page, so every call carries the session cookie the browser has. */
async function api<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async (input) => {
      const res = await fetch(input.path, {
        method: input.method,
        headers: { "content-type": "application/json" },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { method, path, body },
  );
}

test("the loop: a mention ships a pull request, three agents share a repo, and nothing ships unseen", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const stand = world();
  const origin = stand.github.phase3;
  expect(origin, "the phase 3 stand-in GitHub").toBeDefined();
  if (!origin) return;

  // ------------------------------------------------------------------ Ada sets the nest up
  await signUp(page, "Ada", uniqueEmail("ada-phase3"));
  const slug = await createWorkspace(page, "Aviary");

  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("ship");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#ship" })).toBeVisible({ timeout: 30_000 });

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
      const ship = channels.channels.find((one) => one.name === "ship")?.id ?? "";

      // The brain the chat bots run on, and the two connections: the GitHub this repository lives
      // on, and the Supabase a Nest agent will be granted.
      const credential = await post(`/api/workspaces/${ws}/credentials`, {
        provider: "custom",
        kind: "endpoint",
        scope: "workspace",
        label: "Stand-in",
        base_url: `${input.providerUrl}/v1`,
      });
      await post(`/api/workspaces/${ws}/model-profiles`, {
        name: "Aviary brain",
        provider: "custom",
        model_id: "gpt-test-mini",
        credential_id: credential.body.id,
        default_for: "chat",
      });
      const github = await post(`/api/workspaces/${ws}/connections`, {
        kind: "token",
        provider: "github",
        token: input.githubToken,
        owner_type: "workspace",
        api_base: input.githubUrl,
      });
      const supabase = await post(`/api/workspaces/${ws}/connections`, {
        kind: "token",
        provider: "supabase",
        token: input.supabaseToken,
        owner_type: "workspace",
        api_base: input.supabaseUrl,
        mcp_url: input.supabaseMcpUrl,
      });
      // Cloning is its own endpoint, and the connection is what carries the credential.
      const project = await post(`/api/workspaces/${ws}/projects/clone`, {
        name: "Aviary",
        repo_url: input.repoUrl,
        auth: { kind: "connection", connection_id: github.body.id },
      });
      return {
        workspaceId: ws,
        ship,
        /** Kept for the failure message: a clone that did not happen says why here. */
        made: `${project.status} ${JSON.stringify(project.body)}`.slice(0, 300),
        projectId: String(project.body.id ?? ""),
        // Code mode addresses a project by its key, which is what a person reads in the URL.
        projectKey: String(project.body.key ?? ""),
        githubConnection: String(github.body.id ?? ""),
        supabaseConnection: String(supabase.body.id ?? ""),
      };
    },
    {
      providerUrl: stand.provider.url,
      githubUrl: origin.url,
      githubToken: origin.token,
      repoUrl: origin.repoUrl,
      supabaseUrl: stand.supabase.url,
      supabaseMcpUrl: stand.supabase.mcpUrl,
      supabaseToken: stand.supabase.token,
    },
  );
  expect(ids.projectId, ids.made).not.toBe("");

  // The project is cloned before anybody asks an agent to change it.
  await expect
    .poll(
      async () =>
        (
          await api<{ status: string }>(
            page,
            "GET",
            `/api/workspaces/${ids.workspaceId}/projects/${ids.projectId}`,
          )
        ).body.status,
      { timeout: 120_000 },
    )
    .toBe("ready");

  // ------------------------------------------------------------------ the Nest, installed (3.9)
  await page.goto(`/${slug}/settings`);
  const nest = page.getByTestId("nest");
  await expect(nest).toBeVisible({ timeout: 30_000 });
  await nest.getByRole("button", { name: "Install the Nest" }).click();
  await expect(nest.getByTestId("nest-agent").filter({ hasText: "Dawn" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(nest.getByTestId("nest-agent").filter({ hasText: "Kimi" })).toBeVisible();

  // Dawn works on this project and answers in #ship; Kimi answers there too, on the granted
  // connection. Both are the roster's own agents — this only says where they live.
  const bots = await page.evaluate(
    async (input) => {
      const listed = (await (await fetch(`/api/workspaces/${input.ws}/bots`)).json()) as {
        bots: { id: string; handle: string }[];
      };
      const idOf = (handle: string) => listed.bots.find((one) => one.handle === handle)?.id ?? "";
      const patch = async (id: string, body: unknown) =>
        (
          await fetch(`/api/workspaces/${input.ws}/bots/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status;
      const install = async (id: string) =>
        (
          await fetch(`/api/workspaces/${input.ws}/bots/${id}/install`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channel_id: input.ship }),
          })
        ).status;
      const dawn = idOf("dawn");
      const kimi = idOf("kimi");
      await patch(dawn, {
        spec: {
          persona: "You change code.",
          engine: "acp",
          projects: ["Aviary"],
          connection: input.githubConnection,
          triggers: [{ on: "mention" }],
        },
      });
      await patch(kimi, {
        spec: {
          persona: "You say what the data says.",
          brain: { profile: "Aviary brain" },
          triggers: [{ on: "mention" }],
          tools: [],
          mcp: [{ connection: input.supabaseConnection }],
        },
      });
      await install(dawn);
      await install(kimi);
      return { dawn, kimi };
    },
    {
      ws: ids.workspaceId,
      ship: ids.ship,
      githubConnection: ids.githubConnection,
      supabaseConnection: ids.supabaseConnection,
    },
  );
  expect(bots.dawn).not.toBe("");
  expect(bots.kimi).not.toBe("");

  // ------------------------------------------- "@dawn fix X" ships a diff card and a PR (3.7)
  await page.goto(`/${slug}/home/${ids.ship}`);
  const composer = page.getByRole("textbox", { name: "Say something in #ship" });
  await composer.fill("@dawn edit notes.txt so the release notes mention dark mode");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages in #ship" });
  const asked = flow.getByTestId("message").filter({ hasText: "release notes mention dark mode" });
  await expect(asked.getByTestId("reply-count")).toBeVisible({ timeout: 120_000 });
  await asked.getByTestId("reply-count").click();

  const thread = page.getByRole("region", { name: "Thread" });
  // Where the work is: a session card with a way into the IDE.
  await expect(thread.getByTestId("session-card")).toBeVisible({ timeout: 120_000 });
  await expect(
    thread.getByTestId("session-card").getByRole("link", { name: "Open in IDE" }),
  ).toHaveAttribute("href", /\/code\/.*\?session=/);

  // The permission, asked in the thread rather than only in the session pane.
  const permission = thread.getByTestId("block-approve");
  await expect(permission).toBeVisible({ timeout: 120_000 });
  await expect(permission).toContainText("Dawn wants to");
  await sweep(page, "a thread with a session card");
  await permission.getByRole("button", { name: "Approve" }).click();

  // And the end of it: what changed, and the pull request it became.
  const diff = thread.getByTestId("diff-card");
  await expect(diff).toBeVisible({ timeout: 180_000 });
  const pr = diff.getByRole("link", { name: /Pull request #\d+/ });
  await expect(pr).toBeVisible({ timeout: 60_000 });
  const prHref = (await pr.getAttribute("href")) ?? "";
  expect(prHref).toContain("/pull/");
  // The credential opened it and is in none of it (AGENTS.md §1.6).
  expect(await page.content()).not.toContain(origin.token);

  // ------------------------------------------------- the Pull Requests page, where it landed
  await page.goto(`/${slug}/code/${ids.projectKey}`);
  await expect(page.getByRole("heading", { level: 1, name: "Aviary" })).toBeVisible({
    timeout: 120_000,
  });
  const openDrawer = async (name: string) => {
    const tab = page.getByRole("tab", { name, exact: true });
    if (!(await tab.isVisible())) await page.getByRole("button", { name: "Toggle drawer" }).click();
    await tab.click();
  };
  await openDrawer("Pull requests");
  const prs = page.getByTestId("pull-requests");
  await expect(prs).toBeVisible({ timeout: 60_000 });
  // The panel asks which service's pull requests to show: the provider is the truth about them.
  await prs.getByLabel("Connection").selectOption({ label: "github" });
  await expect(prs.getByTestId("pr-row").first()).toBeVisible({ timeout: 90_000 });
  await sweep(page, "the Pull Requests page");

  // --------------------------------- three agents on one repository at once, in worktrees (3.14)
  await page.goto(`/${slug}/work`);
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible({ timeout: 60_000 });
  for (const what of ["edit the header", "edit the footer", "edit the sidebar"]) {
    await page.getByLabel("Title").fill(what);
    await page.getByRole("button", { name: "Add an item" }).click();
    await expect(page.getByRole("article").filter({ hasText: what })).toBeVisible({
      timeout: 30_000,
    });
  }
  await sweep(page, "the board");

  // Handed to an agent one after another, without waiting for the one before: three agents on one
  // repository at the same time is the whole clause.
  for (const what of ["edit the header", "edit the footer", "edit the sidebar"]) {
    await page
      .getByRole("article")
      .filter({ hasText: what })
      .getByRole("button", { name: "Hand to an agent" })
      .click();
  }

  // The three of them finish: an agent finishing is not a person agreeing, so where a card lands
  // is the project's own policy — what matters here is that all three got there.
  const landed = await page.evaluate(
    async (input: { ws: string; project: string }) => {
      const states = async () => {
        const board = (await (
          await fetch(`/api/workspaces/${input.ws}/projects/${input.project}/work-items`)
        ).json()) as { items: { title: string; state: string }[] };
        return board.items
          .filter((one) => one.title.startsWith("edit the "))
          .map((one) => `${one.title}: ${one.state}`);
      };
      const done = (rows: string[]) =>
        rows.length >= 3 && rows.every((row) => !/: (queued|running)$/.test(row));
      let rows = await states();
      for (let i = 0; i < 600 && !done(rows); i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        rows = await states();
      }
      return rows.sort();
    },
    { ws: ids.workspaceId, project: ids.projectId },
  );
  expect(landed.join(" | ")).not.toContain("running");
  expect(landed).toHaveLength(3);

  // Each one worked in its own checkout: three branches, three worktrees, and the project's own
  // directory untouched by any of them. That is what "without conflicts" means — nobody was
  // sharing a working copy, so there was nothing to conflict over (task 3.14).
  const worked = await page.evaluate(
    async ({ ws, project }: { ws: string; project: string }) => {
      const sessions = (await (
        await fetch(`/api/workspaces/${ws}/projects/${project}/sessions`)
      ).json()) as {
        sessions: {
          id: string;
          status: string;
          branch: string | null;
          work_item_id: string | null;
        }[];
      };
      const mine = sessions.sessions.filter((one) => one.work_item_id);
      const status = (await (
        await fetch(`/api/workspaces/${ws}/projects/${project}/git/status`)
      ).json()) as { files?: { path: string }[]; branch?: string };
      return {
        branches: mine.map((one) => one.branch ?? ""),
        statuses: mine.map((one) => one.status),
        dirty: (status.files ?? []).map((one) => one.path),
      };
    },
    { ws: ids.workspaceId, project: ids.projectId },
  );
  expect(worked.branches.length).toBeGreaterThanOrEqual(3);
  expect(new Set(worked.branches).size).toBe(worked.branches.length);
  expect(worked.branches.every((one) => one !== "")).toBe(true);
  expect(worked.statuses).not.toContain("error");
  expect(worked.dirty).toEqual([]);

  // ------------------------------------------------------------------ a race picks a winner (3.16)
  const race = await page.evaluate(
    async (input) => {
      const root = (await (
        await fetch(`/api/workspaces/${input.ws}/channels/${input.ship}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Which way should the banner go?" }),
        })
      ).json()) as { id: string };
      const item = (await (
        await fetch(`/api/workspaces/${input.ws}/projects/${input.project}/work-items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "edit the banner", thread_root_id: root.id }),
        })
      ).json()) as { id: string };
      const started = await fetch(`/api/workspaces/${input.ws}/projects/${input.project}/races`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "edit notes.txt to try the banner",
          // Two different engines, because a race is a comparison: the ACP agent and OpenCode,
          // both of which this machine really runs (scripts/e2e-server.ts stands them up).
          runners: [{ engine: "acp", agent: "fake" }, { engine: "opencode" }],
          work_item_id: item.id,
        }),
      });
      const race = (await started.json()) as { id?: string };
      return { rootId: root.id, status: started.status, raceId: String(race.id ?? "") };
    },
    { ws: ids.workspaceId, ship: ids.ship, project: ids.projectId },
  );
  expect(race.status).toBe(201);

  await page.goto(`/${slug}/home/${ids.ship}`);
  const banner = flow.getByTestId("message").filter({ hasText: "Which way should the banner go?" });
  await expect(banner.getByTestId("reply-count")).toBeVisible({ timeout: 180_000 });
  await banner.getByTestId("reply-count").click();
  // The card is posted as the race moves, so the one to read is the latest.
  const card = () => thread.getByTestId("race-card").last();
  await expect(card()).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(async () => await card().getByTestId("race-entrant").count(), { timeout: 120_000 })
    .toBe(2);
  // Both entrants finish, and the winner is picked: this project has checks, so the race decides
  // itself and says so on the card. A project without them waits for somebody to press Pick,
  // which is `apps/api/test/races.test.ts`'s case.
  await expect(card()).toContainText("Decided", { timeout: 300_000 });
  await expect(card()).toContainText("decided by the checks", { timeout: 120_000 });
  await expect(card().getByTestId("race-entrant").filter({ hasText: "Won" })).toHaveCount(1);
  await expect(card().getByTestId("race-entrant").filter({ hasText: "Discarded" })).toHaveCount(1);

  // -------------------------------- a Nest agent answers from a granted connection (3.6, 3.9)
  const granted = await api<{ id: string }>(
    page,
    "POST",
    `/api/workspaces/${ids.workspaceId}/connections/${ids.supabaseConnection}/grants`,
    { subject_type: "bot", subject_id: bots.kimi, allowed_tools: ["list_tables"] },
  );
  expect([200, 201]).toContain(granted.status);

  await composer.fill("@kimi what tables are in the database?");
  await composer.press("Enter");
  const askedKimi = flow.getByTestId("message").filter({ hasText: "what tables are in the" });
  await expect(askedKimi.getByTestId("reply-count")).toBeVisible({ timeout: 180_000 });
  await askedKimi.getByTestId("reply-count").click();
  // It read the tables through the gateway and said what they were.
  await expect(thread.getByTestId("message").last()).toContainText("What the database says", {
    timeout: 180_000,
  });
  await expect(thread.getByTestId("message").last()).toContainText("birds", { timeout: 60_000 });
  // The Supabase token did the reading and is in none of the page.
  expect(await page.content()).not.toContain(stand.supabase.token);

  // ------------------------------- the agent looks at its own change before it ships it (3.21)
  const looked = await page.evaluate(
    async (input) => {
      const write = async (content: unknown) => {
        const wrote = await fetch(
          `/api/workspaces/${input.ws}/projects/${input.project}/fs/write`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path: ".perch/project.json",
              content: JSON.stringify(content, null, 2),
            }),
          },
        );
        const reloaded = await fetch(
          `/api/workspaces/${input.ws}/projects/${input.project}/config/reload`,
          { method: "POST" },
        );
        return `write ${wrote.status} reload ${reloaded.status} ${(await reloaded.text()).slice(0, 200)}`;
      };
      const preflight = async () => {
        const res = await fetch(`/api/workspaces/${input.ws}/projects/${input.project}/preflight`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel_id: input.ship }),
        });
        return (await res.json()) as {
          passed: boolean;
          rows: { name: string; kind: string; ok: boolean; detail?: string }[];
        };
      };
      const push = async () =>
        (
          await fetch(`/api/workspaces/${input.ws}/projects/${input.project}/git/push`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).status;

      // A page that throws on load: the browser is what notices, and the project says block.
      const base = {
        engine: "acp",
        run: { check: "true" },
        background: { unattended: ["Edit *"], autoSettle: true },
      };
      const said = await write({
        ...base,
        preview: { port: input.vitePort, path: "/", routes: ["/boom.html"], preflight: "block" },
      });
      const bad = await preflight();
      const refused = await push();

      // And the page that is there passes, so the same push is preflight's business no longer.
      await write({
        ...base,
        preview: { port: input.vitePort, path: "/", routes: ["/"], preflight: "block" },
      });
      const good = await preflight();
      return { bad, refused, good, said };
    },
    {
      ws: ids.workspaceId,
      project: ids.projectId,
      ship: ids.ship,
      vitePort: stand.vite.port,
    },
  );
  expect(looked.bad.passed, `${looked.said} rows=${JSON.stringify(looked.bad.rows)}`).toBe(false);
  expect(looked.bad.rows.some((one) => one.kind === "route" && !one.ok)).toBe(true);
  expect(looked.refused).toBe(409);
  expect(looked.good.passed, JSON.stringify(looked.good.rows)).toBe(true);

  // The checklist is a card in the channel, with a row per thing looked at.
  await page.goto(`/${slug}/home/${ids.ship}`);
  const checklist = flow.getByTestId("preflight-card").last();
  await expect(checklist).toBeVisible({ timeout: 60_000 });
  await expect(checklist.getByTestId("preflight-row").first()).toBeVisible();
});
