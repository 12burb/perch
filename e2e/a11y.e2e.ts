import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 4.11: axe on every screen, at 390 px and at 1440 px.
 *
 * The other specs each run axe on the screen they are about, which catches a regression where it
 * happens. This is the sweep: every route the app has, visited in one signed-in session with a
 * channel and a project to show, audited one after another — so a screen nobody happens to be
 * testing this week cannot quietly go bad. `SCREENS` is asserted complete against
 * `apps/web/src/routes/**` by `apps/web/test/screens.test.ts`, so a new route arrives here too.
 *
 * Both viewports come free: playwright.config.ts runs every spec as `desktop` (1440×900) and
 * `mobile` (390×844).
 */

/** A screen: the path to visit, and what has to be on it before axe looks. */
type Screen = {
  /** The route file this covers, relative to apps/web/src/routes. */
  route: string;
  /** The path, with `{ws}`, `{channel}` and `{project}` filled in for this run. */
  path: string;
  /** Something that must be visible first, so axe never audits a spinner. */
  settled: (page: Page) => Promise<void>;
  /** Signed out, so the sweep visits it after signing out rather than inside the shell. */
  signedOut?: boolean;
};

const heading =
  (name: string | RegExp, level = 1) =>
  async (page: Page) => {
    await expect(page.getByRole("heading", { level, name })).toBeVisible({ timeout: 30_000 });
  };

export const SCREENS: Screen[] = [
  { route: "_app/welcome.tsx", path: "/welcome", settled: heading(/Welcome|workspace/i) },
  { route: "_app/$workspace/$mode.tsx", path: "/{ws}/home", settled: heading("Home") },
  {
    route: "_app/$workspace/home.$channel.tsx",
    path: "/{ws}/home/{channel}",
    // The page's own h1 is the mode; the channel is a region inside it.
    settled: async (page) => {
      await expect(page.getByRole("region", { name: "#general" })).toBeVisible({ timeout: 30_000 });
    },
  },
  {
    route: "_app/$workspace/code.$project.tsx",
    path: "/{ws}/code/{project}",
    settled: heading("Sweep"),
  },
  { route: "_app/$workspace/settings.tsx", path: "/{ws}/settings", settled: heading(/Settings/i) },
  {
    route: "_app/$workspace/environments.tsx",
    path: "/{ws}/environments",
    settled: heading(/Environments/i),
  },
  { route: "_app/settings/profile.tsx", path: "/settings/profile", settled: heading(/Profile/i) },
  {
    route: "_app/settings/security.tsx",
    path: "/settings/security",
    settled: heading(/Security/i),
  },
  {
    route: "sign-in.tsx",
    path: "/sign-in",
    signedOut: true,
    settled: async (page) => {
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 30_000 });
    },
  },
  {
    route: "sign-up.tsx",
    path: "/sign-up",
    signedOut: true,
    settled: async (page) => {
      await expect(page.getByLabel("Name")).toBeVisible({ timeout: 30_000 });
    },
  },
  {
    route: "invite.$token.tsx",
    path: "/invite/not-a-real-token",
    signedOut: true,
    // An invite nobody has says so; that message is a screen like any other.
    settled: async (page) => {
      await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    },
  },
];

/**
 * Routes that are not screens, and why. The invariant test reads this beside `SCREENS`, so a new
 * route is either audited or explained — never just missing.
 */
export const NOT_SCREENS: Record<string, string> = {
  "__root.tsx": "the root layout: every screen below is one of its children",
  "_app.tsx": "a layout, and the shell it renders is audited on every screen inside it",
  "_app/$workspace.tsx": "a layout: it resolves the slug and renders an Outlet",
  "index.tsx": "a redirect to Home or Inbox depending on the viewport; both are audited",
  "connections.tsx": "a redirect back from an OAuth provider; it lands on the workspace settings",
  "setup.tsx": "the first-run wizard, audited by e2e/00-setup.e2e.ts where it can be run at all",
};

/** The four modes with no route of their own: `$mode.tsx` renders each. */
const MODES = ["work", "bots", "inbox", "search"] as const;

test("every screen passes axe", async ({ page }, info) => {
  test.setTimeout(240_000);
  const email = uniqueEmail("a11y");
  await signUp(page, "Axe Sweeper", email);
  const ws = await createWorkspace(page, "Axe Nest");

  // A channel and a project, so the two detail routes have something on them.
  await page.goto(`/${ws}/home`);
  const form = page.getByRole("form", { name: "Start a channel" });
  await form.getByLabel("Name", { exact: true }).fill("General");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("region", { name: "#general" })).toBeVisible({ timeout: 30_000 });
  // The channel route takes an id, not a name: the app is on it now, so take it from there.
  const channel = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(channel).not.toBe("");
  await page.goto(`/${ws}/code`);
  await page.getByLabel("Project name").fill("Sweep");
  await page.getByRole("button", { name: "Create project" }).click();
  const row = page.getByTestId("project-row").filter({ hasText: "Sweep" });
  await expect(row.getByTestId("project-status")).toHaveText("Ready", { timeout: 120_000 });

  const fill = (path: string) =>
    path.replace("{ws}", ws).replace("{channel}", channel).replace("{project}", "sweep");

  const bad: string[] = [];
  async function audit(where: string, settle: (page: Page) => Promise<void>): Promise<void> {
    await settle(page);
    const scan = await new AxeBuilder({ page })
      // The iframe on a Preview is the dev server's own page, audited on its own terms (task 1.18).
      .exclude("iframe")
      .analyze();
    for (const violation of scan.violations) {
      bad.push(
        `${where} [${info.project.name}]: ${violation.id} — ${violation.nodes.length} node(s)`,
      );
    }
  }

  for (const screen of SCREENS.filter((one) => !one.signedOut)) {
    await page.goto(fill(screen.path));
    await audit(screen.path, screen.settled);
  }
  for (const mode of MODES) {
    await page.goto(`/${ws}/${mode}`);
    await audit(`/${ws}/${mode}`, heading(new RegExp(mode, "i")));
  }

  // Signed out for real, because that is the state a stranger arrives in.
  await page.context().clearCookies();
  await page.goto("/sign-in");
  for (const screen of SCREENS.filter((one) => one.signedOut)) {
    await page.goto(fill(screen.path));
    await audit(screen.path, screen.settled);
  }

  expect(bad).toEqual([]);
});
