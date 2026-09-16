import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.15 (spec §5.5, §11): the Deploy button and the database panel, in a browser.
 *
 * The acceptance §11 names is the first half: a Vercel deploy posts its preview URL in a thread.
 * It is pressed in the IDE's drawer, the card appears in the channel while the build is still
 * going, and the URL arrives in that same card — not in a second message — once the provider has
 * one. The second half is the database panel: it lists the tables through the MCP gateway and
 * refuses a statement that writes.
 *
 * Both providers are the stand-ins scripts/e2e-server.ts starts, reached through `api_base` and
 * `mcp_url` the way a self-hosted install would be.
 */

type World = {
  vercel: { url: string; token: string };
  supabase: { url: string; mcpUrl: string; token: string };
};

function world(): World {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as World;
}

type Ready = { projectId: string; channelId: string };

test("a deploy posts its preview URL in a thread, and the database panel reads", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const stand = world();
  await signUp(page, "Ship Owner", uniqueEmail("ship"));
  const slug = await createWorkspace(page, "Ship Nest");
  await page.goto(`/${slug}/code`);

  // The project, the channel to announce in, and the two connections — over the same routes the
  // Connections card and the clone form use, because what this spec is about is what comes after.
  const made: Ready = await page.evaluate(
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
      const project = await post(`/api/workspaces/${ws}/projects`, {
        name: "Nest",
        key: "nest",
        source: "empty",
      });
      const channel = await post(`/api/workspaces/${ws}/channels`, {
        type: "public",
        name: "ship",
      });
      await post(`/api/workspaces/${ws}/connections`, {
        kind: "token",
        provider: "vercel",
        token: input.vercelToken,
        owner_type: "workspace",
        api_base: input.vercelUrl,
      });
      await post(`/api/workspaces/${ws}/connections`, {
        kind: "token",
        provider: "supabase",
        token: input.supabaseToken,
        owner_type: "workspace",
        api_base: input.supabaseUrl,
        mcp_url: input.supabaseMcpUrl,
      });
      return {
        projectId: String(project.body.id ?? ""),
        channelId: String(channel.body.id ?? ""),
      };
    },
    {
      vercelUrl: stand.vercel.url,
      vercelToken: stand.vercel.token,
      supabaseUrl: stand.supabase.url,
      supabaseMcpUrl: stand.supabase.mcpUrl,
      supabaseToken: stand.supabase.token,
    },
  );
  expect(made.projectId).not.toBe("");

  const row = page.getByTestId("project-row").filter({ hasText: "Nest" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 120_000 });
  await page.getByRole("link", { name: "Open Nest" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nest" })).toBeVisible();

  // Deploy, from the drawer. (The drawer remembers whether it was open, so it is asked for only
  // when its tabs are not already there.)
  const openDrawer = async (name: string) => {
    const tab = page.getByRole("tab", { name, exact: true });
    if (!(await tab.isVisible())) {
      await page.getByRole("button", { name: "Toggle drawer" }).click();
    }
    await tab.click();
  };
  await openDrawer("Deploy");
  const deploy = page.getByRole("region", { name: "Deploy" });
  await expect(deploy).toBeVisible();

  // A git-based deploy needs a repository, and this project was made empty — so the panel asks for
  // one first, which is the only way a project that was pushed somewhere later can ever deploy.
  await expect(deploy.getByText("has not said where it is")).toBeVisible();
  await deploy.getByLabel("Repository URL").fill("https://github.com/perch/nest.git");
  await deploy.getByRole("button", { name: "Save" }).click();

  await expect(deploy.getByLabel("Announce in")).toBeVisible({ timeout: 20_000 });
  await deploy.getByLabel("Announce in").selectOption({ label: "#ship" });
  await deploy.getByRole("button", { name: "Deploy", exact: true }).click();

  // The build has not finished, so the panel says so rather than inventing a URL.
  const deployment = page.getByTestId("deployment");
  await expect(deployment).toBeVisible({ timeout: 30_000 });
  await expect(deployment).toContainText("Building");

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // The panel keeps asking; the card in the thread is what it rewrites. So the URL shows up in the
  // channel, in the message that was posted before there was one.
  await expect(deployment.getByRole("link")).toHaveText(/vercel\.test/, { timeout: 60_000 });
  await page.goto(`/${slug}/home/${made.channelId}`);
  const card = page.getByTestId("deploy-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Ready", { timeout: 30_000 });
  await expect(card.getByRole("link").first()).toHaveText(/vercel\.test/);

  // The database panel: the schema comes through the MCP gateway, and a write never leaves Perch.
  // A project is addressed by its key in the URL, which is what the sidebar links to.
  await page.goto(`/${slug}/code/nest`);
  await expect(page.getByRole("heading", { level: 1, name: "Nest" })).toBeVisible({
    timeout: 30_000,
  });
  await openDrawer("Database");
  const db = page.getByRole("region", { name: "Database" });
  await expect(db.getByRole("button", { name: /public\.birds/ })).toBeVisible({ timeout: 30_000 });
  await db.getByRole("button", { name: /public\.birds/ }).click();
  await expect(db).toContainText("uuid");

  await db.getByLabel("Read something").fill("select id, name from birds limit 1");
  await db.getByRole("button", { name: "Run" }).click();
  await expect(db.getByRole("table", { name: "Result" })).toContainText("swift", {
    timeout: 30_000,
  });

  await db.getByLabel("Read something").fill("delete from birds");
  await db.getByRole("button", { name: "Run" }).click();
  await expect(db.getByRole("alert")).toContainText("permission prompt", { timeout: 20_000 });

  if (info.project.name !== "mobile") {
    const after = await new AxeBuilder({ page }).analyze();
    expect(after.violations.map((v) => v.id)).toEqual([]);
  }
});
