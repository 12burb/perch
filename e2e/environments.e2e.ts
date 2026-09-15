import { spawn } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.3 (spec §3.2): a laptop registers and shows online from a phone. The Environments page mints a
 * connect token, the runner agent starts with it (the real `apps/runner` entrypoint under Bun, standing
 * in for `perch runner connect`), and the page flips to Online without a reload; stopping the agent
 * flips it back; the page passes axe at both viewports.
 */

// Playwright runs from the repository root (playwright.config.ts), where the runner sources live.
const root = process.cwd();

test("a laptop registers and shows online from a phone", async ({ page, baseURL }, info) => {
  const email = uniqueEmail("env");
  await signUp(page, "Env Owner", email);
  const slug = await createWorkspace(page, "Env Nest");
  await page.goto(`/${slug}/environments`);
  await expect(page.getByRole("heading", { level: 1, name: "Environments" })).toBeVisible();
  await expect(page.getByText("No environments yet")).toBeVisible();

  await page.getByLabel("Machine name").fill("Laptop");
  await page.getByRole("button", { name: "Connect a machine" }).click();
  const command = (await page.getByTestId("connect-command").textContent()) ?? "";
  const token = /prt_[A-Za-z0-9_-]+/.exec(command)?.[0];
  expect(token, command).toBeTruthy();
  const row = page.getByTestId("runner-row").filter({ hasText: "Laptop" });
  await expect(row.getByTestId("runner-status")).toHaveText("Offline");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);

  // The machine: the runner agent with the token, exactly what `perch runner connect` runs.
  const agent = spawn("bun", ["apps/runner/src/main.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PERCH_API_URL: (baseURL ?? "http://127.0.0.1:3999").replace("perch.localhost", "127.0.0.1"),
      PERCH_RUNNER_TOKEN: token ?? "",
      PERCH_RUNNER_NAME: "Laptop",
      PERCH_RUNNER_KIND: "local",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const agentOutput: string[] = [];
  agent.stdout.on("data", (chunk: Buffer) => agentOutput.push(chunk.toString()));
  agent.stderr.on("data", (chunk: Buffer) => agentOutput.push(chunk.toString()));
  try {
    // Live over the workspace topic: no reload.
    await expect(row.getByTestId("runner-status"), agentOutput.join("")).toHaveText("Online", {
      timeout: 20_000,
    });
    await expect(row).toContainText(process.platform);
  } finally {
    agent.kill("SIGTERM");
  }
  await expect(row.getByTestId("runner-status")).toHaveText("Offline", { timeout: 20_000 });

  // Removing revokes the token; the row goes.
  await page.getByRole("button", { name: "Remove Laptop" }).click();
  await expect(page.getByText("No environments yet")).toBeVisible();
  test.info().annotations.push({ type: "project", description: info.project.name });
});
