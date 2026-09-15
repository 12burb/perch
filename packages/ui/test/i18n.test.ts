import { describe, expect, test } from "bun:test";
import code from "../src/i18n/en.code.json" with { type: "json" };
import core from "../src/i18n/en.json" with { type: "json" };
import settings from "../src/i18n/en.settings.json" with { type: "json" };
import { loadedKeys, type MessageKey, t } from "../src/i18n/index.ts";

describe("i18n", () => {
  test("t() returns the en string and fills placeholders", () => {
    expect(t("auth.signIn")).toBe("Sign in");
    expect(t("auth.signedInAs", { name: "Dawn" })).toBe("Signed in as Dawn");
  });

  test("unfilled placeholders are left visible rather than blanked", () => {
    expect(t("auth.signedInAs")).toBe("Signed in as {name}");
  });

  test("a fragment's strings arrive with the chunk that imports it (ADR-0085)", async () => {
    // Before the fragment loads, its key is not in the catalog — which is why a fragment is
    // imported by a module in the chunk that needs it, not fetched when something renders.
    expect(loadedKeys()).not.toContain("editor.save" as MessageKey);
    await import("../src/i18n/code.ts");
    expect(loadedKeys()).toContain("editor.save" as MessageKey);
    expect(t("editor.save")).toBe("Save");
    // Registering twice is harmless.
    await import("../src/i18n/code.ts");
    expect(t("editor.save")).toBe("Save");
  });

  test("every catalog value is a non-empty string, in every fragment", async () => {
    await import("../src/i18n/code.ts");
    await import("../src/i18n/settings.ts");
    for (const key of loadedKeys()) expect(t(key).length).toBeGreaterThan(0);
    expect(t("invite.body", { email: "d@x", workspace: "Nest", role: "member" })).toBe(
      "d@x was invited to join Nest as member.",
    );
  });

  test("no key is in two catalogs, and the split is where it says it is", () => {
    const fragments = { code, settings } as Record<string, Record<string, string>>;
    const seen = new Map<string, string>();
    for (const [name, catalog] of Object.entries({ core, ...fragments })) {
      for (const key of Object.keys(catalog)) {
        const already = seen.get(key);
        expect(already ? `${key} is also in ${already}` : key).toBe(key);
        seen.set(key, name);
      }
    }
    // The core catalog is the shell's vocabulary; a route's belongs to a fragment.
    for (const key of Object.keys(core)) {
      expect(key.split(".")[0]).not.toBe("editor");
      expect(key.split(".")[0]).not.toBe("session");
      expect(key.split(".")[0]).not.toBe("preview");
    }
  });
});
