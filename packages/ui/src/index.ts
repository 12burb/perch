// @perch/ui — Tokens, themes, shadcn base, and the Perch components (spec §4).
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const packageName = "@perch/ui";

/** The shadcn class helper: clsx + tailwind-merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export { getLocale, type Locale, type MessageKey, setLocale, t } from "./i18n/index.ts";
