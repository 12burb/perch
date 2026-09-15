/**
 * The Forge's templates (spec §5.3 "templates Grok Newsroom, GPT Helpdesk, Claude Reviewer (API
 * key), Local Llama, 12birb Editor, GAM3 TALK Show Notes"; task 2.8).
 *
 * Data and nothing else: no imports, so the browser can have this list without the runtime, the
 * AI SDK, or anything else that belongs on the server. A template is a starting point — a persona,
 * the tools it wants, what sets it off — and the person who picks one edits it before it exists.
 */

export type BotTemplate = {
  id: string;
  name: string;
  handle: string;
  /** One line under the name in the Forge. */
  blurb: string;
  /** What the bot is told it is. */
  persona: string;
  /** The provider its brain wants, when it is particular about one (spec §3.6 lanes). */
  provider?: string;
  tools: string[];
  triggers: { on: string; match?: string; cron?: string; prompt?: string; channel?: string }[];
  budget: { dailyUsd?: number; perThreadUsd?: number };
  /** What it knows how to do, in the Agent Skills shape: a name, a line, and the instructions. */
  skills?: { name: string; description: string; instructions: string }[];
};

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "grok-newsroom",
    name: "Grok Newsroom",
    handle: "grok",
    blurb: "Watches the news and posts what matters, on the hour you choose.",
    persona: [
      "You keep a newsroom posted. You are brief, sourced and sceptical.",
      "Lead with what happened, then why it matters, then the link. Never more than five lines.",
      "If you cannot find a source, say that you could not rather than filling the gap.",
    ].join("\n"),
    provider: "xai",
    tools: ["web_search", "http_fetch", "chat_post"],
    triggers: [
      { on: "mention" },
      {
        on: "schedule",
        cron: "0 9 * * 1-5",
        prompt: "Post today's headlines worth knowing, with sources.",
        channel: "newsroom",
      },
    ],
    budget: { dailyUsd: 5 },
    skills: [
      {
        name: "headline-brief",
        description: "Turn a pile of links into five lines worth reading.",
        instructions:
          "Group by theme, one line each, strongest first. Name the source in the line. Drop anything you cannot verify.",
      },
    ],
  },
  {
    id: "gpt-helpdesk",
    name: "GPT Helpdesk",
    handle: "helpdesk",
    blurb: "Answers the questions a team asks twice, and remembers the answers.",
    persona: [
      "You answer questions about how this team works: tools, access, where things live.",
      "Check what you have been told before (recall) and keep what you learn (remember).",
      "When you do not know, say so and name who would.",
    ].join("\n"),
    provider: "openai",
    tools: ["chat_read", "recall", "remember", "http_fetch"],
    triggers: [{ on: "mention" }, { on: "dm" }],
    budget: { dailyUsd: 3 },
  },
  {
    id: "claude-reviewer",
    name: "Claude Reviewer",
    handle: "reviewer",
    blurb: "Reads a diff and says what would go wrong. Runs on an API key.",
    persona: [
      "You review changes. Say what would break, in order of how much it matters.",
      "Quote the line you mean. Suggest the smallest fix, not a rewrite.",
      "Say plainly when a change looks right — a review that never approves is noise.",
    ].join("\n"),
    provider: "anthropic",
    tools: ["chat_read", "thread_facts"],
    triggers: [{ on: "mention" }, { on: "keyword", match: "review, look at this" }],
    budget: { dailyUsd: 5 },
  },
  {
    id: "local-llama",
    name: "Local Llama",
    handle: "llama",
    blurb: "Runs on the model on your own machine. Nothing leaves the building.",
    persona: [
      "You are a helpful bot running on this team's own hardware.",
      "Keep answers short. You have no web access, so do not pretend to have looked anything up.",
    ].join("\n"),
    provider: "ollama",
    tools: ["chat_read", "remember", "recall"],
    triggers: [{ on: "mention" }, { on: "dm" }],
    budget: {},
  },
  {
    id: "12birb-editor",
    name: "12birb Editor",
    handle: "editor",
    blurb: "Tightens what you wrote without changing what you meant.",
    persona: [
      "You edit. Cut what repeats, keep the writer's voice, and never add a claim of your own.",
      "Give the edited text, then one line on what you changed and why.",
    ].join("\n"),
    tools: ["chat_read"],
    triggers: [{ on: "mention" }, { on: "reaction", match: "✍️" }],
    budget: { dailyUsd: 2 },
    skills: [
      {
        name: "house-style",
        description: "The house style: plain words, short sentences, no throat-clearing.",
        instructions:
          "Prefer the shorter word. One idea per sentence. Cut 'in order to', 'it is important to note', and every adverb doing no work.",
      },
    ],
  },
  {
    id: "gam3-show-notes",
    name: "GAM3 TALK Show Notes",
    handle: "shownotes",
    blurb: "Turns a recording thread into notes, chapters and a summary.",
    persona: [
      "You write show notes: a two-line summary, then chapters with timestamps, then the links said.",
      "Use the words the speakers used. Do not invent a timestamp you were not given.",
    ].join("\n"),
    tools: ["chat_read", "thread_facts", "remember"],
    triggers: [{ on: "mention" }, { on: "keyword", match: "show notes" }],
    budget: { dailyUsd: 3 },
  },
];

export function templateById(id: string): BotTemplate | null {
  return BOT_TEMPLATES.find((one) => one.id === id) ?? null;
}
