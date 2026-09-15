import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.6 (spec §5.3): a native bot in a channel. The acceptance, in a browser: somebody names
 * the bot, and the answer arrives in the thread — written by the bot, badged as one, within its
 * budget, with the run recorded.
 *
 * The brain is the stand-in provider the e2e server runs (`scripts/e2e-server.ts`): a real
 * OpenAI-compatible endpoint that streams, so nothing here reaches the internet and nothing is
 * mocked inside Perch.
 */

function providerUrl(): string {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  const world = JSON.parse(readFileSync(path, "utf8")) as { provider: { url: string } };
  return world.provider.url;
}

type Made = { status: number; handle: string; runs: number };

test("a bot answers when it is named, in the thread, and the run is on its ledger", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Robin", uniqueEmail("robin"));
  await createWorkspace(page, "Bot Nest");

  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("newsroom");
  await form.getByRole("button", { name: "Create channel" }).click();
  const channel = page.getByRole("region", { name: "#newsroom" });
  await expect(channel).toBeVisible({ timeout: 30_000 });

  // A brain and a bot, over the same routes the Forge will use in 2.8.
  const made: Made = await page.evaluate(async (endpoint) => {
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
      model_id: "gpt-test-mini",
      credential_id: credential.body.id,
      default_for: "chat",
    });
    const bot = await post(`/api/workspaces/${ws}/bots`, {
      handle: "news",
      name: "Newsroom",
      visibility: "workspace",
      budget: { dailyUsd: 5 },
      spec: {
        persona: "You keep the newsroom posted.",
        brain: { profile: "Stand-in brain" },
        triggers: [{ on: "mention" }],
        tools: [],
      },
    });
    const botId = String(bot.body.id ?? "");
    await post(`/api/workspaces/${ws}/bots/${botId}/install`, { channel_id: channelId });
    const runs = (await (await fetch(`/api/workspaces/${ws}/bots/${botId}/runs`)).json()) as {
      runs: unknown[];
    };
    return { status: bot.status, handle: String(bot.body.handle ?? ""), runs: runs.runs.length };
  }, providerUrl());
  expect(made.status).toBe(201);
  expect(made.handle).toBe("news");
  expect(made.runs).toBe(0);

  // Naming it is all it takes.
  const composer = page.getByRole("textbox", { name: "Say something in #newsroom" });
  await composer.fill("@news what is the plan?");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages in #newsroom" });
  const asked = flow.getByTestId("message").filter({ hasText: "what is the plan?" });
  await expect(asked).toBeVisible({ timeout: 30_000 });

  // The answer hangs off the question, so the channel keeps its shape.
  await expect(asked.getByTestId("reply-count")).toBeVisible({ timeout: 60_000 });
  await asked.getByTestId("reply-count").click();
  const thread = page.getByRole("region", { name: "Thread" });
  const answer = thread.getByTestId("message").filter({ hasText: "Reading you" });
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer).toContainText("what is the plan?");
  // A bot says it is one (spec §4 "Bots in the UI").
  await expect(answer.getByText("BOT")).toBeVisible();
  await expect(answer.getByText("Newsroom")).toBeVisible();

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // And the run is on the ledger, with what it cost.
  const ledger = await page.evaluate(async () => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const bots = (await (await fetch(`/api/workspaces/${ws}/bots`)).json()) as {
      bots: { id: string; handle: string }[];
    };
    const botId = bots.bots.find((row) => row.handle === "news")?.id ?? "";
    const runs = (await (await fetch(`/api/workspaces/${ws}/bots/${botId}/runs`)).json()) as {
      runs: { trigger: string; status: string; input_tokens: number; output_tokens: number }[];
    };
    return runs.runs;
  });
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ trigger: "mention", status: "done", output_tokens: 12 });
});
