import { expect, type Page, test } from "@playwright/test";
import {
  createWorkspace,
  isMobile,
  openAccountMenu,
  PASSWORD,
  secondBrowser,
  signOut,
  signUp,
  uniqueEmail,
} from "./helpers.ts";

/**
 * Task 0.8 acceptance (spec §11): sign up, sign in with a passkey, invite accepted — in a real
 * browser at 1440 px and 390 px. Passkeys use Chromium's virtual authenticator over CDP.
 */

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

test("sign up, add a passkey, sign out, sign in with the passkey", async ({ page }, info) => {
  const mobile = isMobile(info.project.name);
  await addVirtualAuthenticator(page);
  await signUp(page, "Dawn", uniqueEmail("dawn"));
  await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();

  await openAccountMenu(page, mobile);
  await page.getByRole("dialog").getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  await page.getByLabel("Passkey name").fill("test authenticator");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByRole("list", { name: "Passkeys" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Passkeys" })).toContainText("test authenticator");

  await signOut(page, mobile);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as Dawn");
  await expect(page).toHaveURL(/\/welcome$/);
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
  const slug = await createWorkspace(page, workspaceName);

  // The owner invites from workspace settings; the accept link is shown for sharing by hand.
  await page.goto(`/${slug}/settings`);
  await page.getByLabel("Email").fill(uniqueEmail("julius").replace(/^julius/, "julius"));
  const inviteeEmail = await page.getByLabel("Email").inputValue();
  await page.getByRole("button", { name: "Create invite" }).click();
  const acceptUrl = (await page.getByTestId("invite-link").textContent()) ?? "";
  const acceptPath = new URL(acceptUrl).pathname;

  const inviteePage = await secondBrowser(browser);
  await inviteePage.goto(acceptPath);
  await expect(inviteePage.getByTestId("invite-body")).toContainText(workspaceName);
  await inviteePage.getByRole("link", { name: "Create an account to accept" }).click();
  await inviteePage.getByLabel("Name").fill("Julius");
  await inviteePage.getByLabel("Email").fill(inviteeEmail);
  await inviteePage.getByLabel("Password").fill(PASSWORD);
  await inviteePage.getByRole("button", { name: "Create account" }).click();
  await expect(inviteePage).toHaveURL(new RegExp(`${acceptPath}$`));
  await inviteePage.getByRole("button", { name: "Accept invite" }).click();
  await expect(inviteePage.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const members = inviteePage.getByRole("list", { name: "Members" });
  await expect(members).toContainText("Julius");
  await expect(members).toContainText("Member");
  await expect(members).toContainText("Dawn");
  await inviteePage.context().close();
});
