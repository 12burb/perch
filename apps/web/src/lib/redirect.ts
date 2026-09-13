/** Only same-origin absolute paths may be used as post-auth redirects. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  return value;
}

export type RedirectSearch = { redirect?: string };

export function redirectSearch(search: Record<string, unknown>): RedirectSearch {
  const redirect = safeRedirect(search.redirect);
  return redirect ? { redirect } : {};
}
