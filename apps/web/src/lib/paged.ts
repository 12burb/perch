/**
 * A table drawn a page at a time (ground rule 7: a long list is never the whole DOM). The rows come
 * whole from the api; the DOM holds `PAGE` of them, and a page more each time the person asks.
 */
export const PAGE = 100;

export function shownRows<T>(rows: readonly T[], pages: number): { rows: T[]; hidden: number } {
  const shown = rows.slice(0, Math.max(1, Math.floor(pages)) * PAGE);
  return { rows: shown, hidden: rows.length - shown.length };
}
