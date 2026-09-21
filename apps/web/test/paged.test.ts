import { describe, expect, test } from "bun:test";
import { PAGE, shownRows } from "../src/lib/paged.ts";

/** Ground rule 7, for the tables that draw a page at a time (ADR-0167). */
describe("a paged table", () => {
  const rows = Array.from({ length: 250 }, (_, i) => i);

  test("draws one page, and says how many rows wait behind it", () => {
    expect(shownRows(rows, 1)).toEqual({ rows: rows.slice(0, PAGE), hidden: 250 - PAGE });
    expect(shownRows(rows, 2)).toEqual({ rows: rows.slice(0, 2 * PAGE), hidden: 250 - 2 * PAGE });
    expect(shownRows(rows, 3)).toEqual({ rows, hidden: 0 });
    expect(shownRows(rows, 9)).toEqual({ rows, hidden: 0 });
  });

  test("a short list is drawn whole, and a page count below one still draws a page", () => {
    expect(shownRows([1, 2, 3], 1)).toEqual({ rows: [1, 2, 3], hidden: 0 });
    expect(shownRows(rows, 0).rows).toHaveLength(PAGE);
    expect(shownRows(rows, -2).rows).toHaveLength(PAGE);
  });
});
