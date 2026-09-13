import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Task 0.8 acceptance (spec §11): sign up, sign in with a passkey, invite accepted — in a real
 * browser at 1440 px and 390 px. Passkeys use Chromium's virtual authenticator over CDP.
 */

const PASSWORD = "correct horse battery staple";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("signed-in-as")).toHaveText(`Signed in as ${name}`);
}

test("sign up, add a passkey, sign out, sign in with the passkey", async ({ page }) => {
  await addVirtualAuthenticator(page);
  const email = uniqueEmail("dawn");
  await signUp(page, "Dawn", email);

  await page.getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();
  await page.getByLabel("Passkey name").fill("test authenticator");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByRole("list", { name: "Passkeys" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Passkeys" })).toContainText("test authenticator");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Perch" })).toBeVisible();

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as Dawn");
  await expect(page).toHaveURL(/\/$/);
});

test("an api token is shown once and lists without its secret", async ({ page }) => {
  await signUp(page, "Paige", uniqueEmail("paige"));
  await page.goto("/settings/security");
  await page.getByLabel("Token name").fill("laptop");
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.getByTestId("created-token").textContent();
  expect(token?.startsWith("pat_")).toBe(true);
  await expect(page.getByRole("list", { name: "API tokens" })).toContainText("laptop");
  await expect(page.getByRole("list", { name: "API tokens" })).not.toContainText(token ?? "pat_");
  const me = await page.request.get("/api/me", { headers: { authorization: `Bearer ${token}` } });
  expect(me.ok()).toBe(true);
  expect(((await me.json()) as { auth_kind: string }).auth_kind).toBe("token");
});

test("an invite is accepted by the invited email in a second browser", async ({
  page,
  browser,
}) => {
  await signUp(page, "Dawn", uniqueEmail("owner"));
  const workspaceName = `The Nest ${Date.now()}`;
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  const item = page.getByRole("list", { name: "Your workspaces" }).getByRole("listitem");
  await expect(item).toContainText(workspaceName);
  const workspaceId = await item.getAttribute("data-workspace-id");
  expect(workspaceId).toBeTruthy();

  const inviteeEmail = uniqueEmail("julius");
  const invited = await page.request.post(`/api/workspaces/${workspaceId}/invites`, {
    data: { email: inviteeEmail, role: "member" },
  });
  expect(invited.status()).toBe(201);
  const { accept_url } = (await invited.json()) as { accept_url: string };
  const acceptPath = new URL(accept_url).pathname;

  const inviteePage = await openSecondBrowser(browser);
  await inviteePage.goto(acceptPath);
  await expect(inviteePage.getByTestId("invite-body")).toContainText(workspaceName);
  await inviteePage.getByRole("link", { name: "Create an account to accept" }).click();
  await inviteePage.getByLabel("Name").fill("Julius");
  await inviteePage.getByLabel("Email").fill(inviteeEmail);
  await inviteePage.getByLabel("Password").fill(PASSWORD);
  await inviteePage.getByRole("button", { name: "Create account" }).click();
  await expect(inviteePage).toHaveURL(new RegExp(`${acceptPath}$`));
  await inviteePage.getByRole("button", { name: "Accept invite" }).click();
  const joined = inviteePage.getByRole("list", { name: "Your workspaces" }).getByRole("listitem");
  await expect(joined).toContainText(workspaceName);
  await expect(joined).toContainText("Member");
  await inviteePage.context().close();
});

async function openSecondBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}
