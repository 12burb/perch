import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.16 (spec §3.5, §5.5): connecting a service from the Connections card. The paste lane is
 * the one a person can complete without leaving Perch, so it is the one the spec drives: a token
 * goes in, the connection comes back as the account it speaks as, and the token is never on the
 * page again. The GitHub App wizard shows the two URLs it prefills, which is the thing nobody
 * should have to work out for themselves.
 */

test("the Connections card: the App wizard's URLs, and a token refused on its shape", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUp(page, "Connect Owner", uniqueEmail("connect"));
  const slug = await createWorkspace(page, "Connect Nest");
  // A webhook posts its cards into a channel, so the workspace has one to choose.
  await page.evaluate(async (wanted) => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string; slug: string }[];
    };
    const ws = mine.workspaces.find((one) => one.slug === wanted)?.id ?? "";
    await fetch(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "public", name: "github" }),
    });
  }, slug);
  await page.goto(`/${slug}/settings`);

  const connections = page.getByRole("region", { name: "Connections" });
  await expect(connections.getByRole("heading", { name: "Nothing connected yet" })).toBeVisible();

  // The App wizard prefills the callback URL from this instance's public URL, and makes the App a
  // webhook endpoint of its own: a URL with that endpoint's id in it, and the secret GitHub signs
  // deliveries with, shown once (ADR-0173; the old prefilled /hooks/github/<workspace> URL was a
  // route nothing served).
  const form = connections.getByRole("form", { name: "Connect" });
  await form.getByLabel("Service").selectOption("github");
  await form.getByLabel("How to connect").selectOption("github_app");
  await expect(form.getByText("/api/connect/callback/github")).toBeVisible();
  const webhook = form.getByRole("region", { name: "Webhook" });
  await webhook.getByRole("button", { name: "Make webhook endpoint" }).click();
  await expect(webhook.getByText(/\/hooks\/github\/[0-9a-f-]{36}/)).toBeVisible();
  await expect(webhook.getByRole("status")).toContainText("shown this once");
  await expect(form.getByLabel("App ID")).toBeVisible();
  await expect(form.getByLabel("Private key (PEM)")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // The paste lane. A paste from the wrong field is refused on its shape, before Perch asks any
  // provider anything — which is the only part of connecting that needs no third party, and so the
  // only part an end-to-end spec should depend on. What a provider does with a token it dislikes
  // is covered in apps/api/test/connections.test.ts against a stand-in.
  await form.getByLabel("How to connect").selectOption("token");
  await form.getByLabel("Token", { exact: true }).fill("sk-this-is-an-openai-key");
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(connections.getByRole("alert")).toContainText("does not look like", {
    timeout: 20_000,
  });
  await expect(connections.getByRole("heading", { name: "Nothing connected yet" })).toBeVisible();
});

/**
 * Task 2.14 (spec §3.5): the MCP OAuth lane end to end, and who may use what afterwards.
 *
 * The provider is the stand-in MCP server scripts/e2e-server.ts starts — RFC 9728 metadata, RFC
 * 8414 endpoints, RFC 7591 registration, and an authorize endpoint that redirects straight back —
 * reached the way a self-hosted Supabase would be, through the MCP server box. Nothing about the
 * protocol is faked: Perch discovers, registers a client on the spot, sends the browser out with
 * PKCE, and trades the code it comes back with. Then the connection is Ada's, and a bot the whole
 * workspace can talk to is refused it unless it acts on her behalf.
 */

function standInMcp(): string {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  const world = JSON.parse(readFileSync(path, "utf8")) as { mcp?: { url?: string } };
  const url = world.mcp?.url;
  if (!url) throw new Error("the e2e manifest has no stand-in MCP server");
  return url;
}

test("an MCP server that registers clients on the spot, and who may use it after", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUp(page, "Ada Connect", uniqueEmail("mcp"));
  const slug = await createWorkspace(page, "MCP Nest");

  // A bot the whole workspace can talk to, which is what the on-behalf-of rule is about.
  await page.goto(`/${slug}/settings`);
  const made = await page.evaluate(async () => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const res = await fetch(`/api/workspaces/${ws}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "deputy", name: "Deputy", visibility: "workspace" }),
    });
    return { status: res.status };
  });
  expect(made.status).toBe(201);

  await page.reload();
  const connections = page.getByRole("region", { name: "Connections" });
  const form = connections.getByRole("form", { name: "Connect" });
  await form.getByLabel("Service").selectOption("supabase");
  await form.getByLabel("How to connect").selectOption("mcp_oauth");
  // The BYO card is offered first, because an app somebody registered beats one Perch registers.
  await expect(connections.getByRole("region", { name: "Use my own app" })).toBeVisible();
  await form.getByLabel("MCP server (optional)").fill(standInMcp());

  // Out to the provider and back: Perch discovers, registers itself, and trades the code.
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/settings\?connected=supabase/, { timeout: 30_000 });
  await expect(connections.getByRole("status").first()).toContainText("Connected Supabase");

  const row = connections.getByRole("listitem").filter({ hasText: "Supabase" });
  await expect(row).toBeVisible();
  // The lane it was made on, and that it is Ada's rather than the workspace's.
  await expect(row).toContainText("Sign in through its MCP server");
  await expect(row).toContainText("Only me");
  // Nothing on the page is the token it traded for.
  expect(await page.content()).not.toContain("mcp-access-");

  // Who may use it. A shared bot is refused outright, and allowed on her behalf.
  await row.getByRole("button", { name: "Who may use it" }).click();
  const grants = connections.getByTestId("connection-grants");
  await expect(grants).toBeVisible();
  await expect(grants.getByText("Nothing may use it yet.")).toBeVisible();
  await grants.getByLabel("Bot").selectOption({ label: "Deputy" });

  const obo = grants.getByLabel("On my behalf only");
  await obo.uncheck();
  await grants.getByRole("button", { name: "Grant" }).click();
  await expect(grants.getByRole("alert")).toContainText("on their behalf", { timeout: 20_000 });

  await obo.check();
  await grants.getByRole("button", { name: "Grant" }).click();
  const granted = grants.getByTestId("grant");
  await expect(granted).toHaveCount(1, { timeout: 20_000 });
  await expect(granted).toContainText("Deputy");
  await expect(granted).toContainText("On my behalf only");

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // And taking it away leaves nothing behind.
  await granted.getByRole("button", { name: "Take Deputy off" }).click();
  await expect(grants.getByText("Nothing may use it yet.")).toBeVisible({ timeout: 20_000 });
});
