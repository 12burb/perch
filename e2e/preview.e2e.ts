import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.18 (spec §5.6): the Preview tab. A real Vite dev server runs beside the e2e server
 * (scripts/e2e-server.ts); this spec watches it through Perch in both modes, edits one of its
 * modules and waits for the page to change without a reload — which is HMR and nothing else — and
 * shares a link that opens with no Perch session at all.
 *
 * Perch answers on `perch.localhost` and previews on `<port>--<slug>.perch.localhost`, which the
 * browser resolves by itself — the same shape as a real instance behind wildcard DNS.
 */

const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? "3997");
/** Where scripts/e2e-server.ts wrote the Vite app; the same fixed path on both sides. */
const VITE_DIR = process.env.E2E_VITE_DIR ?? join(tmpdir(), "perch-e2e-preview-app");
const DOMAIN = process.env.E2E_PREVIEW_DOMAIN ?? "perch.localhost";
const APP_PORT = new URL(process.env.E2E_BASE_URL ?? "http://perch.localhost:3999").port;

test("a dev server runs in the Preview tab, hot-reloads, and shares by link", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  // Every socket the page opens, so the HMR assertion cannot be satisfied by Vite's own fallback:
  // its client retries straight at the dev server when the proxied socket fails, which would work
  // here only because the browser happens to share a machine with it.
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  const email = uniqueEmail("preview");
  await signUp(page, "Preview Owner", email);
  const slug = await createWorkspace(page, "Preview Nest");

  // A project to hang the preview on: the ports belong to the workspace's runner either way.
  await page.goto(`/${slug}/code`);
  await page.getByLabel("Project name").fill("Site");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Site" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 90_000 });
  await page.getByRole("link", { name: "Site" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Site" })).toBeVisible();

  // The Preview tab, by URL: ⌘⇧P does the same from the keyboard.
  await page.goto(`/${slug}/code/site?view=preview&port=${VITE_PORT}`);
  const preview = page.getByRole("region", { name: "Preview", exact: true });
  await expect(preview).toBeVisible({ timeout: 30_000 });

  // Wildcard mode: the iframe is on the preview's own hostname, and the dev server answers.
  const frame = preview.locator("iframe");
  await expect(frame).toHaveAttribute(
    "src",
    new RegExp(`^http://${VITE_PORT}--${slug}\\.${DOMAIN.replace(/\\./g, "\\\\.")}:${APP_PORT}/`),
  );
  const app = page.frameLocator("iframe").locator("#app");
  await expect(app).toHaveText(/^version (one|two)$/, { timeout: 60_000 });

  // HMR: change a module the page accepts hot; the text changes with no reload. Which way round
  // depends on what a previous run left behind, so the edit is always to the other one.
  const before = (await app.textContent())?.trim() ?? "";
  const after = before === "version one" ? "version two" : "version one";
  writeFileSync(join(VITE_DIR, "src", "message.js"), `export const message = "${after}";\n`);
  await expect(app).toHaveText(after, { timeout: 30_000 });
  // …and it came through Perch: the socket is on the preview's hostname, and the dev server was
  // never reached directly.
  expect(sockets.some((url) => url.includes(`${VITE_PORT}--${slug}.${DOMAIN}`))).toBe(true);
  expect(sockets.some((url) => url.includes(`127.0.0.1:${VITE_PORT}`))).toBe(false);

  // Path mode: the same dev server on Perch's own origin, which needs no DNS at all. Fetched from
  // the page, because only the browser has the resolver rules that stand in for wildcard DNS.
  const pathMode = await page.evaluate(async (port: number) => {
    const ws = (await (await fetch("/api/workspaces")).json()) as {
      workspaces: { id: string }[];
    };
    const id = ws.workspaces[0]?.id ?? "";
    const res = await fetch(`/p/${id}/${port}/`);
    return { id, status: res.status, body: (await res.text()).slice(0, 400) };
  }, VITE_PORT);
  expect(pathMode.id).not.toBe("");
  expect(pathMode.status).toBe(200);
  expect(pathMode.body).toContain('id="app"');

  if (info.project.name !== "mobile") {
    // The viewport presets size the frame rather than the window (spec §5.6).
    await preview.getByLabel("Viewport").selectOption("phone");
    await expect(frame).toHaveJSProperty("clientWidth", 390);
    await preview.getByLabel("Viewport").selectOption("fit");
  }

  // Share: a link anyone can open, shown once.
  await preview.getByRole("button", { name: "Share" }).click();
  const share = page.getByRole("region", { name: "Share this preview" });
  await expect(share).toBeVisible();
  await share.getByRole("button", { name: "Create a link" }).click();
  const link = share.locator("p.font-mono");
  await expect(link).toBeVisible();
  const url = (await link.textContent())?.trim() ?? "";
  expect(url).toContain("perch_share=");

  // A browser that has never seen Perch opens it, and gets the dev server's own page.
  const guest = await browser.newContext();
  try {
    const guestPage = await guest.newPage();
    await guestPage.goto(url);
    await expect(guestPage.locator("#app")).toHaveText(/version (one|two)/, { timeout: 30_000 });
    // §5.6: a share never carries the inspector — neither the injected script nor its source.
    // (`data-perch-src` is the app's own markup, put there by the dev plugin, so a guest sees it
    // exactly as the dev server serves it; what a share must not get is anything Perch added.)
    const html = await guestPage.content();
    expect(html).not.toContain("perch-inspector");
    const refused = await guestPage.evaluate(async () => {
      const res = await fetch("/__perch/inspector.js?nonce=x");
      return res.status;
    });
    expect(refused).toBeGreaterThanOrEqual(400);
  } finally {
    await guest.close();
  }

  // Revoking closes it for everyone holding the link.
  await share
    .getByRole("button", { name: /^Revoke/ })
    .first()
    .click();
  const revoked = await browser.newContext();
  try {
    const revokedPage = await revoked.newPage();
    // A browser, so the preview hostname resolves the way it does for everybody else.
    const answer = await revokedPage.goto(url);
    expect(answer?.status()).toBe(403);
  } finally {
    await revoked.close();
  }

  const scan = await new AxeBuilder({ page })
    .include("main")
    // The iframe is the dev server's page, not Perch's, and is audited on its own terms.
    .exclude("iframe")
    .analyze();
  expect(scan.violations).toEqual([]);
});
