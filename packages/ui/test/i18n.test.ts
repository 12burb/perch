import { describe, expect, test } from "bun:test";
import { messageKeys, t } from "../src/i18n/index.ts";

describe("i18n", () => {
  test("t() returns the en string and fills placeholders", () => {
    expect(t("auth.signIn")).toBe("Sign in");
    expect(t("auth.signedInAs", { name: "Dawn" })).toBe("Signed in as Dawn");
    expect(t("invite.body", { email: "d@x", workspace: "Nest", role: "member" })).toBe(
      "d@x was invited to join Nest as member.",
    );
  });

  test("unfilled placeholders are left visible rather than blanked", () => {
    expect(t("auth.signedInAs")).toBe("Signed in as {name}");
  });

  test("every catalog value is a non-empty string", () => {
    for (const key of messageKeys) expect(t(key).length).toBeGreaterThan(0);
  });
});
