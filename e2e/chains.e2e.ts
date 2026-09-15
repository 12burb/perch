import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.7 (spec §5.4): one bot tags another, and the thread says so. The lead answers a person,
 * tags the desk, the desk answers, and the thread's header counts the hops and what they cost.
 */

function providerUrl(): string {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  const world = JSON.parse(readFileSync(path, "utf8")) as { provider: { url: string } };
  return world.provider.url;
}

test("a bot tags another, and the thread's header counts the hops", async ({ page }, info) => {
  test.setTimeout(120_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Robin", uniqueEmail("robin"));
  await createWorkspace(page, "Chain Nest");

  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("newsroom");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#newsroom" })).toBeVisible({ timeout: 30_000 });

  const made: { status: number } = await page.evaluate(async (endpoint) => {
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
    const list = (await (await fetch(`/api/workspaces/${ws}/channels`)).json()) as {
      channels: { id: string; name: string | null }[];
    };
    const channelId = list.channels.find((row) => row.name === "newsroom")?.id ?? "";
    const credential = await post(`/api/workspaces/${ws}/credentials`, {
      provider: "custom",
      kind: "endpoint",
      scope: "workspace",
      label: "Stand-in",
      base_url: `${endpoint}/v1`,
    });
    await post(`/api/workspaces/${ws}/model-profiles`, {
      name: "Stand-in brain",
      provider: "custom",
      model_id: "gpt-4o-mini",
      credential_id: credential.body.id,
      default_for: "chat",
    });
    let status = 0;
    for (const [handle, name] of [
      ["lead", "Lead"],
      ["gamma", "Gamma"],
    ]) {
      const bot = await post(`/api/workspaces/${ws}/bots`, {
        handle,
        name,
        visibility: "workspace",
        budget: { dailyUsd: 5, perThreadUsd: 1 },
        spec: {
          persona: `You are ${name}.`,
          brain: { profile: "Stand-in brain" },
          triggers: [{ on: "mention" }],
          tools: [],
        },
      });
      status = bot.status;
      await post(`/api/workspaces/${ws}/bots/${String(bot.body.id)}/install`, {
        channel_id: channelId,
      });
    }
    return { status };
  }, providerUrl());
  expect(made.status).toBe(201);

  // A person asks the lead, the lead asks the desk, and the desk answers — all in one thread.
  const composer = page.getByRole("textbox", { name: "Say something in #newsroom" });
  await composer.fill("@lead what is the desk working on?");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages in #newsroom" });
  const asked = flow.getByTestId("message").filter({ hasText: "what is the desk working on?" });
  await expect(asked.getByTestId("reply-count")).toBeVisible({ timeout: 60_000 });
  await asked.getByTestId("reply-count").click();

  const thread = page.getByRole("region", { name: "Thread" });
  await expect(thread.getByTestId("message").filter({ hasText: "Reading you" })).toBeVisible({
    timeout: 60_000,
  });

  // The header is what says a chain happened: two hops, two bots, and what it cost.
  const header = thread.getByTestId("chain-header");
  await expect(header).toBeVisible({ timeout: 60_000 });
  await expect(header).toContainText("2 hops");
  await expect(header).toContainText("Lead");
  await expect(header).toContainText("Gamma");

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }
});
