import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, isMobile, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 2.5 (spec §5.2): the blocks a bot asks a question with. A bot cannot author a message until
 * the runtime lands in 2.6, so the question is posted over the same REST contract a bot will use,
 * and what this proves is the other half: the block is answered in place, the message carries its
 * own outcome, and it still does when the page is opened again.
 */

const BLOCKS = [
  { type: "text", text: "Release 1.4.2 is ready." },
  { type: "approve_deny", id: "deploy", text: "Deploy it?", action: "deploy" },
  {
    type: "select",
    id: "where",
    text: "Where to",
    action: "choose_env",
    options: [
      { label: "Staging", value: "staging" },
      { label: "Production", value: "production" },
    ],
  },
  { type: "progress", id: "build", text: "Building", value: 0.42 },
];

type Posted = { status: number; message: string };

test("a question in blocks is answered in place, and stays answered", async ({ page }, info) => {
  test.setTimeout(120_000);
  const mobile = isMobile(info.project.name);
  await signUp(page, "Wren", uniqueEmail("wren"));
  await createWorkspace(page, "Blocks Nest");

  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("deploys");
  await form.getByRole("button", { name: "Create channel" }).click();
  const channel = page.getByRole("region", { name: "#deploys" });
  await expect(channel).toBeVisible({ timeout: 30_000 });

  // The message a bot will post in 2.6, posted over the contract it will use (spec §7.1).
  const posted: Posted = await page.evaluate(async (blocks) => {
    const mine = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const ws = mine.workspaces[0]?.id ?? "";
    const list = (await (await fetch(`/api/workspaces/${ws}/channels`)).json()) as {
      channels: { id: string; name: string | null }[];
    };
    const found = list.channels.find((row) => row.name === "deploys");
    const res = await fetch(`/api/workspaces/${ws}/channels/${found?.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks }),
    });
    const body = (await res.json()) as { id?: string };
    return { status: res.status, message: body.id ?? "" };
  }, BLOCKS);
  expect(posted.status).toBe(201);

  // It arrives without a reload: the channel is listening (spec §7.7 message.created).
  const flow = page.getByRole("log", { name: "Messages in #deploys" });
  const message = flow.getByTestId("message").filter({ hasText: "Release 1.4.2 is ready." });
  await expect(message).toBeVisible({ timeout: 30_000 });

  // Progress is the bot's to move: it reports, it takes no press.
  await expect(message.getByRole("progressbar", { name: "Building" })).toHaveAttribute(
    "aria-valuenow",
    "42",
  );

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }

  // ── Approve: the block answers itself, and says who answered ────────────────────────────────
  const approve = message.getByTestId("block-approve");
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(approve).toContainText("Approved", { timeout: 30_000 });
  await expect(approve.getByTestId("block-answer")).toContainText("Wren");
  // Answered is answered: there is nothing left to press.
  await expect(approve.getByRole("button")).toHaveCount(0);
  // And it is not an edit: the message gains no "(edited)" mark.
  await expect(message.getByRole("button", { name: "(edited)" })).toHaveCount(0);

  // ── A select sends what was chosen, and afterwards shows the option, not its value ──────────
  const select = message.getByTestId("block-select");
  await select.getByLabel("Where to").selectOption("production");
  await select.getByRole("button", { name: "Send" }).click();
  await expect(select.getByTestId("block-chosen")).toHaveText("Production", { timeout: 30_000 });

  // ── Opening it again reads the same thing: the answer lives in the message ──────────────────
  await page.reload();
  const again = page
    .getByRole("log", { name: "Messages in #deploys" })
    .getByTestId("message")
    .filter({ hasText: "Release 1.4.2 is ready." });
  await expect(again.getByTestId("block-approve")).toContainText("Approved", { timeout: 30_000 });
  await expect(again.getByTestId("block-chosen")).toHaveText("Production");
  await expect(again.getByTestId("block-approve").getByRole("button")).toHaveCount(0);

  if (!mobile) {
    const scan = await new AxeBuilder({ page }).include("main").analyze();
    expect(scan.violations).toEqual([]);
  }
});
