/**
 * Every user-facing string goes through `t("key")` (spec §9.1), even with only `en` shipped.
 * Catalogs are flat JSON; `{name}` placeholders are filled from params.
 *
 * The catalog is split so the first paint does not carry the whole app's vocabulary (ADR-0085).
 * `en.json` holds what the shell itself says — the rail, the sidebars, sign-in, the command
 * palette. Everything a route owns lives in a fragment beside it (`en.chat.json`,
 * `en.code.json`, `en.settings.json`) which registers itself when that route's chunk loads:
 * `import "@perch/ui/i18n/code"` at the top of a module in the chunk, and the strings are there
 * before anything in it renders, because ES modules run their imports first.
 *
 * Two rules keep this honest, and `bun run perf` enforces the first:
 * 1. A fragment's key is never used from a module the entry chunk reaches. The perf audit fails on
 *    a fragment key found in the built entry, which catches both a shell string that wandered into
 *    a fragment and a fragment dragged into the first paint.
 * 2. The `import` goes in a component module, never in a route file: TanStack Router's
 *    autoCodeSplitting keeps a route file's own imports in the eagerly loaded half, so a fragment
 *    registered there would be in the entry after all. A route's components register it instead,
 *    and the route's own `t()` calls live in the component half that loads with them.
 */

import type chat from "./en.chat.json";
import type code from "./en.code.json";
import type inbox from "./en.inbox.json";
import en from "./en.json" with { type: "json" };
import type settings from "./en.settings.json";
import type work from "./en.work.json";

/** Every key that exists, whichever fragment ships it: `t()` is typed across all of them. */
export type MessageKey =
  | keyof typeof en
  | keyof typeof chat
  | keyof typeof code
  | keyof typeof inbox
  | keyof typeof settings
  | keyof typeof work;
export type Locale = "en";
export type MessageParams = Record<string, string | number>;

const catalogs: Record<Locale, Record<string, string>> = { en: { ...en } };
let current: Locale = "en";

/**
 * Adds a fragment's strings. Called at module scope by the fragment modules, so a chunk's strings
 * arrive with the chunk; calling it twice with the same fragment is harmless.
 */
export function addMessages(locale: Locale, messages: Record<string, string>): void {
  catalogs[locale] = { ...catalogs[locale], ...messages };
}

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: MessageKey, params?: MessageParams): string {
  const template = catalogs[current][key] ?? catalogs.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** The keys loaded right now: the core catalog, plus whatever fragments this chunk pulled in. */
export function loadedKeys(): MessageKey[] {
  return Object.keys(catalogs.en) as MessageKey[];
}
