import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.8 (spec §5.3 "Forge UI (form + live test chat + templates)"): making a bot without
 * writing anything. The acceptance is the spec's own: create Grok Newsroom, and @grok answers in a
 * channel.
 */

function providerUrl(): string {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  const world = JSON.parse(readFileSync(path, "utf8")) as { provider: { url: string } };
  return world.provider.url;
}

test("a template becomes a bot, is tried in the Forge, and answers in a channel", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Robin", uniqueEmail("robin"));
  const slug = await createWorkspace(page, "Forge Nest");

  // A channel for it to work in, and a brain for it to run on.
  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("general");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#general" })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async (endpoint) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json() as Promise<Record<string, unknown>>;
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
    await post(`/api/workspaces/${ws}/model-profiles`, {
      name: "Stand-in brain",
      provider: "custom",
      model_id: "gpt-4o-mini",
      credential_id: credential.id,
      default_for: "chat",
    });
  }, providerUrl());

  // The Forge: pick the template, and the form is filled in.
  await page.goto(`/${slug}/settings`);
  const forge = page.getByRole("region", { name: "Bots" });
  await expect(forge).toBeVisible({ timeout: 30_000 });
  await forge.getByTestId("bot-template").filter({ hasText: "Grok Newsroom" }).click();
  const newBot = page.getByRole("form", { name: "New bot" });
  await expect(newBot.getByLabel("Name", { exact: true })).toHaveValue("Grok Newsroom");
  await expect(newBot.getByLabel("Handle")).toHaveValue("grok");
  await expect(newBot.getByLabel("What it is")).toContainText("newsroom");

  // It runs on the workspace's brain and everybody may talk to it.
  await newBot.getByLabel("Brain").selectOption("Stand-in brain");
  await newBot.getByLabel("Everyone can talk to it").check();
  await newBot.getByRole("button", { name: "Create bot" }).click();

  const card = page.getByTestId("bot").filter({ hasText: "Grok Newsroom" });
  await expect(card).toBeVisible({ timeout: 30_000 });

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // Put it in the channel, then try it without saying anything there.
  await card.getByLabel("#general").click();
  await expect(card.getByLabel("#general")).toBeChecked({ timeout: 30_000 });
  await card.getByLabel("Try it").fill("are you there?");
  await card.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(card.getByTestId("bot-test-reply")).toContainText("Reading you", {
    timeout: 60_000,
  });

  // And in the channel, where everybody can see it: @grok answers in #general.
  await page.goto(`/${slug}/home`);
  const row = page.getByTestId("channel-row").filter({ hasText: "general" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("link", { name: "Open general" }).click();
  await expect(page.getByRole("region", { name: "#general" })).toBeVisible({ timeout: 30_000 });
  const composer = page.getByRole("textbox", { name: "Say something in #general" });
  await composer.fill("@grok what is the news?");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages in #general" });
  const asked = flow.getByTestId("message").filter({ hasText: "what is the news?" });
  await expect(asked.getByTestId("reply-count")).toBeVisible({ timeout: 60_000 });
  await asked.getByTestId("reply-count").click();
  const thread = page.getByRole("region", { name: "Thread" });
  const answer = thread.getByTestId("message").filter({ hasText: "Reading you" });
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer.getByText("Grok Newsroom")).toBeVisible();
});
