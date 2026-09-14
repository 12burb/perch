import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.4 (spec §5.1): from Code mode, clone a public repository and create an empty project; the
 * rows go Pending → Setting up → Ready live over the workspace topic, the clone shows its branch and
 * head, the deploy key is one click away, deleting removes the row, and the page passes axe at both
 * viewports. The in-process runner of laptop mode does the work.
 */

const PUBLIC_REPO = "https://github.com/octocat/Hello-World.git";

test("clone a public repository and create an empty project", async ({ page }, info) => {
  test.setTimeout(240_000); // a real clone from GitHub
  const email = uniqueEmail("proj");
  await signUp(page, "Project Owner", email);
  const slug = await createWorkspace(page, "Project Nest");
  await page.goto(`/${slug}/code`);
  await expect(page.getByRole("heading", { level: 1, name: "Code" })).toBeVisible();
  await expect(
    page.getByRole("status").getByText("No projects yet", { exact: true }),
  ).toBeVisible();

  // Clone: the public repository, no credentials.
  await page.getByLabel("Project name").fill("Hello World");
  await page.getByRole("radio", { name: "Clone a repository" }).check();
  await page.getByLabel("Repository URL").fill(PUBLIC_REPO);
  await page.getByLabel("Authentication").selectOption("deploy_key");
  await expect(page.getByTestId("deploy-key")).toContainText("ssh-ed25519", { timeout: 15_000 });
  await page.getByLabel("Authentication").selectOption("none");
  await page.getByRole("button", { name: "Create project" }).click();
  const hello = page.getByTestId("project-row").filter({ hasText: "Hello World" });
  await expect(hello).toBeVisible();
  await expect(hello).toContainText("hello-world");
  await expect(hello.getByTestId("project-status")).toHaveText("Ready", { timeout: 90_000 });
  if (info.project.name !== "mobile") {
    await expect(hello).toContainText("master");
    await expect(hello).toContainText("opencode");
  }

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);

  // Empty: a fresh repository on the requested branch.
  await page.getByLabel("Project name").fill("Scratch");
  await page.getByRole("radio", { name: "Empty" }).check();
  await page.getByLabel("Default branch").fill("develop");
  await page.getByRole("button", { name: "Create project" }).click();
  const scratch = page.getByTestId("project-row").filter({ hasText: "Scratch" });
  await expect(scratch.getByTestId("project-status")).toHaveText("Ready", { timeout: 30_000 });
  if (info.project.name !== "mobile") await expect(scratch).toContainText("develop");

  // The sidebar lists both (desktop; the sidebar is a drawer on a phone).
  if (info.project.name !== "mobile") {
    // The sidebar item is named exactly; the row's link is "Open Hello World" (task 1.6).
    await expect(page.getByRole("link", { name: "Hello World", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Scratch", exact: true })).toBeVisible();
  }

  // A bad URL is refused by the api and shown inline.
  await page.getByLabel("Project name").fill("Broken");
  await page.getByRole("radio", { name: "Clone a repository" }).check();
  await page.getByLabel("Repository URL").fill("https://user:token@example.com/r.git");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("alert")).toContainText("put the token in auth");

  await page.getByRole("button", { name: "Delete Scratch" }).click();
  await expect(scratch).toHaveCount(0);
  await expect(hello).toBeVisible();
  test.info().annotations.push({ type: "project", description: info.project.name });
});
