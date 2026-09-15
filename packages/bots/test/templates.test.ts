import { describe, expect, test } from "bun:test";
import { BOT_TOOLS, botSpecSchema } from "@perch/db";
import { BOT_TEMPLATES, templateById } from "../src/templates.ts";

/** Task 2.8: the Forge's six starting points (spec §5.3). */
describe("bot templates", () => {
  test("the six the spec names are here, each with its own handle", () => {
    expect(BOT_TEMPLATES.map((one) => one.id)).toEqual([
      "grok-newsroom",
      "gpt-helpdesk",
      "claude-reviewer",
      "local-llama",
      "12birb-editor",
      "gam3-show-notes",
    ]);
    const handles = BOT_TEMPLATES.map((one) => one.handle);
    expect(new Set(handles).size).toBe(handles.length);
    expect(templateById("grok-newsroom")?.name).toBe("Grok Newsroom");
    expect(templateById("nothing")).toBeNull();
  });

  test("every template is a spec the api would take", () => {
    // The templates are plain data, so their tools are strings until the schema vouches for them.
    const known: readonly string[] = BOT_TOOLS;
    for (const template of BOT_TEMPLATES) {
      const parsed = botSpecSchema.safeParse({
        persona: template.persona,
        tools: template.tools,
        triggers: template.triggers,
        ...(template.skills ? { skills: template.skills } : {}),
      });
      expect(parsed.success).toBe(true);
      // Only tools that exist, and a persona that actually says something.
      for (const tool of template.tools) expect(known).toContain(tool);
      expect(template.persona.length).toBeGreaterThan(40);
      expect(template.blurb.length).toBeGreaterThan(10);
    }
  });

  test("a scheduled template says when and where", () => {
    const newsroom = templateById("grok-newsroom");
    const schedule = newsroom?.triggers.find((one) => one.on === "schedule");
    expect(schedule?.cron).toBe("0 9 * * 1-5");
    expect(schedule?.channel).toBe("newsroom");
    expect(schedule?.prompt).toContain("headlines");
  });
});
