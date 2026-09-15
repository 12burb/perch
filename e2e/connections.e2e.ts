import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers.ts";

/**
 * Task 1.16 (spec §3.5, §5.5): connecting a service from the Connections card. The paste lane is
 * the one a person can complete without leaving Perch, so it is the one the spec drives: a token
 * goes in, the connection comes back as the account it speaks as, and the token is never on the
 * page again. The GitHub App wizard shows the two URLs it prefills, which is the thing nobody
 * should have to work out for themselves.
 */

test("the Connections card: the App wizard's URLs, and a token refused on its shape", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUp(page, "Connect Owner", uniqueEmail("connect"));
  const slug = await createWorkspace(page, "Connect Nest");
  await page.goto(`/${slug}/settings`);

  const connections = page.getByRole("region", { name: "Connections" });
  await expect(connections.getByRole("heading", { name: "Nothing connected yet" })).toBeVisible();

  // The App wizard prefills the callback and webhook URLs from this instance's public URL.
  const form = connections.getByRole("form", { name: "Connect" });
  await form.getByLabel("Service").selectOption("github");
  await form.getByLabel("How to connect").selectOption("github_app");
  await expect(form.getByText("/api/connect/callback/github")).toBeVisible();
  await expect(form.getByText("/hooks/github/")).toBeVisible();
  await expect(form.getByLabel("App ID")).toBeVisible();
  await expect(form.getByLabel("Private key (PEM)")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
  ).toEqual([]);

  // The paste lane. A paste from the wrong field is refused on its shape, before Perch asks any
  // provider anything — which is the only part of connecting that needs no third party, and so the
  // only part an end-to-end spec should depend on. What a provider does with a token it dislikes
  // is covered in apps/api/test/connections.test.ts against a stand-in.
  await form.getByLabel("How to connect").selectOption("token");
  await form.getByLabel("Token", { exact: true }).fill("sk-this-is-an-openai-key");
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(connections.getByRole("alert")).toContainText("does not look like", {
    timeout: 20_000,
  });
  await expect(connections.getByRole("heading", { name: "Nothing connected yet" })).toBeVisible();
});
