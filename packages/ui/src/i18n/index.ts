/**
 * Every user-facing string goes through `t("key")` (spec §9.1), even with only `en` shipped.
 * Catalogs are flat JSON; `{name}` placeholders are filled from params.
 */
import en from "./en.json" with { type: "json" };

export type MessageKey = keyof typeof en;
export type Locale = "en";
export type MessageParams = Record<string, string | number>;

const catalogs: Record<Locale, Record<string, string>> = { en };
let current: Locale = "en";

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

export const messageKeys = Object.keys(en) as MessageKey[];
