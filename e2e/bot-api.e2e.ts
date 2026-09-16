import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.19 (spec §7.3): the Bot API, from the side a person sees it. An admin mints a token in the
 * Forge, the value is shown exactly once, and a program holding it posts into a channel as the bot.
 *
 * The protocol itself — scopes, the socket, `app_mention`, the sixty-a-minute budget — is covered
 * by `apps/api/test/bot-api.test.ts` against `@perch/bot-sdk`. What this adds is the path a person
 * actually walks: settings → a token → a script that works.
 */

test("a token minted in the Forge lets a program post as the bot", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Robin", uniqueEmail("robin"));
  const slug = await createWorkspace(page, "Token Nest");

  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("general");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#general" })).toBeVisible({ timeout: 30_000 });

  await page.goto(`/${slug}/settings`);
  const forge = page.getByRole("region", { name: "Bots" });
  await expect(forge).toBeVisible({ timeout: 30_000 });
  const newBot = page.getByRole("form", { name: "New bot" });
  await newBot.getByLabel("Name", { exact: true }).fill("Scribe");
  await newBot.getByLabel("Handle").fill("scribe");
  await newBot.getByLabel("What it is").fill("Takes notes.");
  await newBot.getByRole("button", { name: "Create bot" }).click();

  const card = page.getByTestId("bot").filter({ hasText: "Scribe" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByLabel("#general").click();
  await expect(card.getByLabel("#general")).toBeChecked({ timeout: 30_000 });

  // Mint it: a name, what it may do, and the value once.
  await card.getByText("Bot API tokens").click();
  await card.getByLabel("What it is for").fill("The newsroom script");
  await card.getByRole("button", { name: "Create token" }).click();
  const shown = card.getByTestId("bot-token-value");
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const token = ((await shown.textContent()) ?? "").trim();
  expect(token.startsWith("pbot_")).toBe(true);

  // The list keeps a hint and never the value.
  const row = card.getByTestId("bot-token");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("chat:write");
  await expect(row).not.toContainText(token);

  // And a program holding it posts as the bot, with nothing but the token.
  const channelId = await page.evaluate(async () => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const list = (await (await fetch(`/api/workspaces/${ws}/channels`)).json()) as {
      channels: { id: string; name: string | null }[];
    };
    return list.channels.find((one) => one.name === "general")?.id ?? "";
  });
  const posted = await page.evaluate(
    async ([bearer, channel]) => {
      const res = await fetch("/api/bot/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ channel, text: "reporting for duty" }),
      });
      return { status: res.status, body: (await res.json()) as { ok?: boolean } };
    },
    [token, channelId] as const,
  );
  expect(posted.status).toBe(200);
  expect(posted.body.ok).toBe(true);

  await page.goto(`/${slug}/home`);
  const channelRow = page.getByTestId("channel-row").filter({ hasText: "general" });
  await expect(channelRow).toBeVisible({ timeout: 30_000 });
  await channelRow.getByRole("link", { name: "Open general" }).click();
  const flow = page.getByRole("log", { name: "Messages in #general" });
  const said = flow.getByTestId("message").filter({ hasText: "reporting for duty" });
  await expect(said).toBeVisible({ timeout: 30_000 });
  await expect(said.getByText("Scribe")).toBeVisible();

  // Revoked, it is nobody.
  await page.goto(`/${slug}/settings`);
  await card.getByText("Bot API tokens").click();
  await card.getByRole("button", { name: "Revoke The newsroom script" }).click();
  await expect(card.getByTestId("bot-token")).toHaveCount(0, { timeout: 30_000 });
  const after = await page.evaluate(async (bearer) => {
    const res = await fetch("/api/bot/conversations.list", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    return res.status;
  }, token);
  expect(after).toBe(401);
});
