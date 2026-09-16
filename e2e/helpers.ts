import { type Browser, expect, type Page } from "@playwright/test";

export const PASSWORD = "correct horse battery staple";

/**
 * The api as Node can reach it. The browser uses `perch.localhost` (see playwright.config.ts), which
 * it resolves itself; Playwright's request contexts run in Node, which has no such convention, so a
 * call made outside a page addresses the loopback interface directly.
 */
export const apiBase = (process.env.E2E_BASE_URL ?? "http://perch.localhost:3999").replace(
  "perch.localhost",
  "127.0.0.1",
);

/**
 * The account this instance was set up with, which is not the same account in both modes: with
 * `E2E_SETUP=wizard` (CI) the wizard spec makes it through the UI, and otherwise
 * `scripts/e2e-server.ts` seeds one before any spec runs. Tests that need the *instance's* admin —
 * the only account `/api/admin/*` answers — ask here rather than guessing.
 */
export const INSTANCE_ADMIN =
  process.env.E2E_SETUP === "wizard"
    ? { email: "dawn@example.test", password: PASSWORD }
    : { email: "admin@perch.test", password: "admin-passphrase-for-tests" };

/** Signs in through the form and waits until the sign-in page is behind us. */
export async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto("/sign-in");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 30_000 });
}

/** The slug of the first workspace this account is in, asked through the browser's own session. */
export async function firstWorkspaceSlug(page: Page): Promise<string> {
  const slug = await page.evaluate(async () => {
    const res = await fetch("/api/workspaces", { credentials: "include" });
    const body = (await res.json()) as { workspaces?: { slug?: string }[] };
    return body.workspaces?.[0]?.slug ?? "";
  });
  expect(slug).not.toBe("");
  return slug;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

/** Signs up through the UI; a brand-new user lands on the welcome page inside the shell. */
export async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("signed-in-as")).toHaveText(`Signed in as ${name}`);
}

/** Creates a workspace from the welcome page and waits for its Home mode. */
export async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto("/welcome");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const slug = new URL(page.url()).pathname.split("/")[1] ?? "";
  expect(slug).not.toBe("");
  return slug;
}

/** Opens the account menu: the rail avatar on desktop, the More tab on a phone. */
export async function openAccountMenu(page: Page, mobile: boolean): Promise<void> {
  if (mobile) {
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "More" })
      .click();
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
    return;
  }
  await page.getByRole("button", { name: /: Settings$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

export async function signOut(page: Page, mobile: boolean): Promise<void> {
  await openAccountMenu(page, mobile);
  await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Perch" })).toBeVisible();
}

export async function secondBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

export function isMobile(projectName: string): boolean {
  return projectName === "mobile";
}
