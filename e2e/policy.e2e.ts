import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.11 (spec §5.7 policy engine). The acceptance, in a browser: a channel pinned to local
 * models refuses a cloud profile — the bot says so where it was asked instead of answering — and
 * `git push --force` comes back refused from the dry run beside the document.
 */

function providerUrl(): string {
  const path = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
  const world = JSON.parse(readFileSync(path, "utf8")) as { provider: { url: string } };
  return world.provider.url;
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

test("a channel pinned to local models refuses a cloud brain, and a force push is refused", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Robin", uniqueEmail("robin"));
  const slug = await createWorkspace(page, "Policy Nest");

  // A channel, a brain, and a bot that answers when it is named.
  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("local-only");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#local-only" })).toBeVisible({ timeout: 30_000 });
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
    const list = (await (await fetch(`/api/workspaces/${ws}/channels`)).json()) as {
      channels: { id: string; name: string | null }[];
    };
    const channelId = list.channels.find((row) => row.name === "local-only")?.id ?? "";
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
      credential_id: credential.id,
      default_for: "chat",
    });
    const bot = await post(`/api/workspaces/${ws}/bots`, {
      handle: "scribe",
      name: "Scribe",
      visibility: "workspace",
      budget: { dailyUsd: 5 },
      spec: { brain: { profile: "Stand-in brain" }, triggers: [{ on: "mention" }], tools: [] },
    });
    await post(`/api/workspaces/${ws}/bots/${String(bot.id)}/install`, { channel_id: channelId });
  }, providerUrl());

  // The policy is written where the workspace is settled.
  await page.goto(`/${slug}/settings`);
  const document = page.getByRole("form", { name: "The policy" });
  await expect(document).toBeVisible({ timeout: 30_000 });
  await document.getByLabel("The policy").fill(POLICY);
  await document.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByTestId("policy-saved")).toBeVisible({ timeout: 30_000 });

  // The dry run answers for a command nobody should run — the acceptance's other half.
  const dryRun = page.getByRole("form", { name: "Would this be allowed?" });
  await dryRun.getByLabel("Command").fill("git push --force origin main");
  await dryRun.getByRole("button", { name: "Check" }).click();
  const answer = page.getByTestId("policy-answer");
  await expect(answer).toContainText("Refused by commands.deny", { timeout: 30_000 });
  await dryRun.getByLabel("Command").fill("bun test");
  await dryRun.getByRole("button", { name: "Check" }).click();
  await expect(answer).toContainText("Allowed");

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // And in the channel the rule is about: the bot says it cannot, rather than answering.
  await page.goto(`/${slug}/home`);
  const row = page.getByTestId("channel-row").filter({ hasText: "local-only" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("link", { name: "Open local-only" }).click();
  const composer = page.getByRole("textbox", { name: "Say something in #local-only" });
  await composer.fill("@scribe what is the plan?");
  await composer.press("Enter");
  const flow = page.getByRole("log", { name: "Messages in #local-only" });
  const asked = flow.getByTestId("message").filter({ hasText: "what is the plan?" });
  await expect(asked.getByTestId("reply-count")).toBeVisible({ timeout: 60_000 });
  await asked.getByTestId("reply-count").click();
  const thread = page.getByRole("region", { name: "Thread" });
  await expect(thread.getByTestId("message").last()).toContainText("list of models", {
    timeout: 60_000,
  });
});
