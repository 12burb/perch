/**
 * What `@codebase` puts in front of a model (spec §5.7 "codebase index … behind @codebase"; task
 * 2.17), and the AGENTS.md a new project is offered.
 *
 * Both are the same idea: the index knows where things are, and a model does not, so the useful
 * thing to hand it is a short list of real places — `path:line`, with the code — rather than a
 * summary of them. Every block cites its file, which is what makes an answer checkable.
 */

/** The marker a person types. Anywhere in the turn, not only at the start. */
export const CODEBASE_MENTION = /(^|\s)@codebase\b/i;

export function mentionsCodebase(text: string): boolean {
  return CODEBASE_MENTION.test(text);
}

/** The question, without the marker, for searching with. */
export function questionOf(text: string): string {
  return text
    .replace(/(^|\s)@codebase\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type ContextChunk = {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  symbol?: string | null;
};

export type ContextOptions = {
  /** Characters; a context block bigger than this crowds out the question itself. */
  maxChars?: number;
};

const DEFAULT_MAX = 12_000;

/**
 * The block prepended to a turn. Fenced per file with its path and lines on the fence, because that
 * is the form every coding model already reads — and the form a person can check by opening it.
 */
export function codebaseContext(
  chunks: readonly ContextChunk[],
  options: ContextOptions = {},
): string {
  if (chunks.length === 0) return "";
  const maxChars = options.maxChars ?? DEFAULT_MAX;
  const parts: string[] = [
    "From this project's index (each block says which file and lines it came from; cite them):",
  ];
  let spent = parts[0]?.length ?? 0;
  for (const chunk of chunks) {
    const where = `${chunk.path}:${chunk.startLine}-${chunk.endLine}`;
    const heading = chunk.symbol ? `${where} — ${chunk.symbol}` : where;
    const block = `\n\n${heading}\n\`\`\`\n${chunk.content}\n\`\`\``;
    if (spent + block.length > maxChars) break;
    parts.push(block);
    spent += block.length;
  }
  return parts.join("");
}

/** The turn as the engine should see it: the context, then what the person actually asked. */
export function withCodebase(text: string, chunks: readonly ContextChunk[]): string {
  const context = codebaseContext(chunks);
  return context ? `${context}\n\n${text}` : text;
}

export type RepoFacts = {
  name: string;
  /** Paths at the top of the repository, which is most of what says what kind of project it is. */
  rootFiles: readonly string[];
  /** Directories at the top, in the order they should be read. */
  directories: readonly string[];
  /** Scripts from package.json, when there is one. */
  scripts?: Record<string, string> | undefined;
  /** The first paragraph of the README, when there is one. */
  readme?: string | undefined;
};

/**
 * The AGENTS.md a new project starts from (spec §5.7 "generated repo docs and an AGENTS.md draft
 * for new projects"). It is a draft on purpose: it says only what the repository itself shows —
 * the layout, the scripts, the languages — and leaves the judgement calls as prompts for a person,
 * because an operating manual nobody wrote is worse than none.
 */
export function agentsDraft(facts: RepoFacts): string {
  const lines: string[] = [
    `# ${facts.name} — agent operating manual`,
    "",
    "Drafted by Perch from what is in this repository. Read it, correct it, and keep it: an agent",
    "reads this file at the start of every session.",
    "",
  ];
  if (facts.readme) {
    lines.push("## What this is", "", facts.readme.trim(), "");
  }
  if (facts.directories.length > 0) {
    lines.push(
      "## Layout",
      "",
      ...facts.directories.map((one) => `- \`${one}/\` — TODO: say what lives here.`),
      "",
    );
  }
  const scripts = Object.entries(facts.scripts ?? {});
  if (scripts.length > 0) {
    lines.push("## Commands", "", "| Command | Does |", "|---|---|");
    for (const [name, command] of scripts.slice(0, 20)) {
      lines.push(`| \`${name}\` | \`${command}\` |`);
    }
    lines.push("");
  }
  lines.push(
    "## Ground rules",
    "",
    "TODO: the things an agent must not do here — the branches it may not push to, the commands it",
    "may not run, the files it may not touch. Perch enforces `.perch/policy.yaml`; this file is for",
    "everything a policy cannot express.",
    "",
    "## Definition of done",
    "",
    "TODO: what has to be true before a change is finished — tests, docs, a changeset, a review.",
    "",
  );
  if (facts.rootFiles.length > 0) {
    lines.push(
      "## Worth reading first",
      "",
      ...facts.rootFiles.slice(0, 12).map((one) => `- \`${one}\``),
      "",
    );
  }
  return lines.join("\n");
}
