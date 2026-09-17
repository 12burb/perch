import { describe, expect, test } from "bun:test";
import { BOT_TEMPLATES } from "@perch/bots/templates";
import { BUILT_IN } from "@perch/connectors";
import { STACKS } from "@perch/templates";
import { catalog, HUB_KINDS, hubCounts, hubItem, hubKey, searchHub } from "../src/index.ts";

/**
 * The Hub's index (task 4.12).
 *
 * The thing worth testing about an index is not that it has rows: it is that it has *every* row,
 * that nothing in it points at something this build does not have, and that what each row says
 * Install will do is a sentence somebody can read before pressing it.
 */

describe("the Hub index (task 4.12)", () => {
  test("every connector, bot template and starter stack is in it", () => {
    const ids = (kind: string) =>
      catalog()
        .filter((one) => one.kind === kind)
        .map((one) => one.id)
        .sort();
    expect(ids("connector")).toEqual([...BUILT_IN].sort());
    expect(ids("bot")).toEqual([...BOT_TEMPLATES.map((one) => one.id)].sort());
    expect(ids("template")).toEqual([...STACKS.map((one) => one.id)].sort());
  });

  test("every skill a bot template carries is offered on its own", () => {
    const skills = BOT_TEMPLATES.flatMap((template) =>
      (template.skills ?? []).map((skill) => ({ skill: skill.name, parent: template.id })),
    );
    expect(skills.length).toBeGreaterThan(0);
    for (const { skill, parent } of skills) {
      const item = hubItem("skill", skill);
      expect(item?.parent, skill).toBe(parent);
    }
  });

  test("every row says what it is and what installing it does", () => {
    for (const item of catalog()) {
      expect(HUB_KINDS).toContain(item.kind);
      expect(item.id, item.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      // X is a connector, and "X" is its whole name.
      expect(item.name.length, item.id).toBeGreaterThan(0);
      expect(item.blurb.length, item.id).toBeGreaterThan(10);
      // Long enough to be a sentence: "what pressing this does" is the whole point of the row.
      expect(item.installs.length, item.id).toBeGreaterThan(20);
      expect(item.tags.length, item.id).toBeGreaterThan(0);
      expect(item.from, item.id).toMatch(/\.(ts|yaml)$/);
    }
  });

  test("a key is unique across the whole index", () => {
    const keys = catalog().map(hubKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("it is sorted by kind and then by name, so the page does not have to sort it", () => {
    const seen: string[] = [];
    for (const item of catalog()) if (!seen.includes(item.kind)) seen.push(item.kind);
    expect(seen).toEqual(HUB_KINDS.filter((kind) => hubCounts()[kind] > 0));
    for (const kind of HUB_KINDS) {
      const names = catalog()
        .filter((one) => one.kind === kind)
        .map((one) => one.name);
      expect(names, kind).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    }
  });

  test("the counts add up", () => {
    const counts = hubCounts();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(catalog().length);
    for (const kind of HUB_KINDS) expect(counts[kind], kind).toBeGreaterThan(0);
  });

  test("search matches a name, a blurb or a tag, and filters by kind", () => {
    expect(searchHub({ kind: "bot" }).every((one) => one.kind === "bot")).toBe(true);
    expect(searchHub({ q: "github" }).some((one) => one.id === "github")).toBe(true);
    // A tag match: every bot carries "bot", so nothing drops out of a kind filter with it.
    expect(searchHub({ kind: "bot", q: "bot" }).length).toBe(hubCounts().bot);
    expect(searchHub({ q: "nothing here matches this at all" })).toEqual([]);
    // Case and spacing are what somebody types, not what they mean.
    expect(searchHub({ q: "  GitHub " }).length).toBe(searchHub({ q: "github" }).length);
  });

  test("an item nobody has is undefined rather than an error", () => {
    expect(hubItem("bot", "not-a-thing")).toBeUndefined();
    expect(hubItem("nonsense", "github")).toBeUndefined();
  });
});
