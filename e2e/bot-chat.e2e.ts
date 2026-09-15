import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.9 (spec §5.2 "DM-a-bot: New chat starts a fresh thread; model picker per DM when the bot
 * allows"). The acceptance, in a browser: open the chat with a bot from Home's Bots section, say
 * something and be answered, press New chat and watch the bot start on nothing, then put it on
 * another brain and see the ledger say so.
 *
 * The stand-in provider says how many messages it was shown, which is what makes a fresh chat
 * visible rather than inferred.
 */

function providerUrl(): string {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  const world = JSON.parse(readFileSync(path, "utf8")) as { provider: { url: string } };
  return world.provider.url;
}

test("a chat with a bot: New chat starts it over, and the brain is the person's to pick", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Robin", uniqueEmail("robin"));
  const slug = await createWorkspace(page, "Chat Nest");

  // Two brains and a bot that lets its own be chosen, over the routes the Forge uses.
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
    const credential = await post(`/api/workspaces/${ws}/credentials`, {
      provider: "custom",
      kind: "endpoint",
      scope: "workspace",
      label: "Stand-in",
      base_url: `${endpoint}/v1`,
    });
    for (const [name, modelId, fallback] of [
      ["Everyday", "gpt-test-mini", "chat"],
      ["The big one", "gpt-test-big", null],
    ] as const) {
      await post(`/api/workspaces/${ws}/model-profiles`, {
        name,
        provider: "custom",
        model_id: modelId,
        credential_id: credential.body.id,
        ...(fallback ? { default_for: fallback } : {}),
      });
    }
    const bot = await post(`/api/workspaces/${ws}/bots`, {
      handle: "ada",
      name: "Ada",
      visibility: "workspace",
      budget: { dailyUsd: 5 },
      spec: {
        persona: "You answer in a chat of your own.",
        brain: { profile: "Everyday", pick: true },
        triggers: [{ on: "dm" }],
        tools: [],
      },
    });
    return { status: bot.status };
  }, providerUrl());
  expect(made.status).toBe(201);

  // Home's Bots section is where a chat with a bot starts.
  await page.goto(`/${slug}/home`);
  if (mobile) await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const inSidebar = page.getByRole("button", { name: "@ada" });
  await expect(inSidebar).toBeVisible({ timeout: 30_000 });
  await inSidebar.click();
  if (mobile) await page.keyboard.press("Escape");

  const chat = page.getByRole("region", { name: "Chat with Ada" });
  await expect(chat).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByText("BOT")).toBeVisible();

  // Say something: the bot answers in the chat itself, having been shown just the one message.
  const composer = page.getByRole("textbox", { name: "Say something to Ada" });
  await composer.fill("remember the number seven");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages with Ada" });
  const first = flow.getByTestId("message").filter({ hasText: "Reading you" });
  await expect(first).toBeVisible({ timeout: 60_000 });
  await expect(first).toContainText("remember the number seven");
  await expect(first).toContainText("(1 shown)");

  // More in the same chat: now it has the whole chat in front of it.
  await composer.fill("and what was it?");
  await composer.press("Enter");
  const second = flow.getByTestId("message").filter({ hasText: "(3 shown)" });
  await expect(second).toBeVisible({ timeout: 60_000 });

  // New chat: the flow empties, and what the bot is shown is only what is said in the new one.
  await chat.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("chat-fresh")).toBeVisible();
  await expect(flow.getByTestId("message")).toHaveCount(0);
  await composer.fill("and now?");
  await composer.press("Enter");
  const fresh = flow.getByTestId("message").filter({ hasText: "Reading you" });
  await expect(fresh).toBeVisible({ timeout: 60_000 });
  await expect(fresh).toContainText("(1 shown)");
  // The chat it started in is still there, and going back to it shows what was said.
  await chat
    .getByLabel("Chat", { exact: true })
    .selectOption({ label: "remember the number seven" });
  await expect(flow.getByTestId("message").filter({ hasText: "(3 shown)" })).toBeVisible({
    timeout: 30_000,
  });

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // The brain is the person's to pick here, and the ledger says which one answered.
  await chat.getByLabel("Brain").selectOption({ label: "The big one" });
  await composer.fill("who are you on?");
  await composer.press("Enter");
  await expect(
    flow.getByTestId("message").filter({ hasText: "who are you on?" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const mine = (await (await fetch("/api/workspaces")).json()) as {
            workspaces: { id: string }[];
          };
          const ws = mine.workspaces[0]?.id ?? "";
          const bots = (await (await fetch(`/api/workspaces/${ws}/bots`)).json()) as {
            bots: { id: string; handle: string }[];
          };
          const botId = bots.bots.find((row) => row.handle === "ada")?.id ?? "";
          const runs = (await (await fetch(`/api/workspaces/${ws}/bots/${botId}/runs`)).json()) as {
            runs: { model_id: string | null }[];
          };
          return runs.runs[0]?.model_id ?? "";
        }),
      { timeout: 60_000 },
    )
    .toBe("gpt-test-big");
});
