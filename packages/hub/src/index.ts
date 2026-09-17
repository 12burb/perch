/**
 * The Hub (task 4.12; spec §10 Phase 4 "Hub v1"): one index of everything this build ships that a
 * workspace can take on — connectors, bots, skills and templates — in one shape, so a person
 * looking for something does not have to know which of four screens it lives behind.
 *
 * v1 indexes what is *in the build*. There is no registry to fetch, no signature to check and
 * nothing to trust: every item here came from `connectors/`, `@perch/bots`, or `@perch/templates`
 * in this same commit, which is why installing one cannot go wrong in the ways a marketplace can
 * (ADR-0158). A remote index is the Hub marketplace, and the spec puts that in "Later".
 */
import { BOT_TEMPLATES, type BotTemplate } from "@perch/bots/templates";
import { parseManifest } from "@perch/connect";
import { MANIFESTS } from "@perch/connectors";
import { STACKS } from "@perch/templates";

/** The four things the Hub knows about. */
export const HUB_KINDS = ["connector", "bot", "skill", "template"] as const;
export type HubKind = (typeof HUB_KINDS)[number];

export type HubItem = {
  kind: HubKind;
  /** Unique within its kind; `bot/grok-newsroom` is unique across the index. */
  id: string;
  name: string;
  /** One line, under the name. */
  blurb: string;
  /** What pressing Install does, said plainly, so the button never surprises. */
  installs: string;
  tags: string[];
  /** Which part of this build it came from, so an operator can go and read it. */
  from: string;
  /** A bot's handle, or the bot a skill was written for. */
  handle?: string;
  /** A skill's parent bot template id: the skill is installed onto a bot, not on its own. */
  parent?: string;
  /** A connector's lanes, best first (spec §3.5). */
  auth?: string[];
  /** A connector's documentation. */
  docsUrl?: string;
  /** A template's dev-server port. */
  port?: number;
};

/** `kind/id`, which is what a URL and an install request carry. */
export function hubKey(item: { kind: HubKind; id: string }): string {
  return `${item.kind}/${item.id}`;
}

function connectorItems(): HubItem[] {
  const out: HubItem[] = [];
  for (const [id, source] of Object.entries(MANIFESTS)) {
    // A manifest that does not parse is a bug in this repository, not a reason to hide the rest of
    // the index: it is left out and the build's own manifest tests are what catch it.
    let manifest: ReturnType<typeof parseManifest>;
    try {
      manifest = parseManifest(source);
    } catch {
      continue;
    }
    out.push({
      kind: "connector",
      id,
      name: manifest.name,
      blurb: manifest.summary ?? `Connect ${manifest.name} to this workspace.`,
      installs: "Opens the Connections card for this provider, where you sign in or paste a token.",
      tags: ["connection", ...manifest.auth],
      from: `connectors/${id}/manifest.yaml`,
      auth: [...manifest.auth],
      ...(manifest.docs_url ? { docsUrl: manifest.docs_url } : {}),
    });
  }
  return out;
}

function botItems(): HubItem[] {
  return BOT_TEMPLATES.map((template) => ({
    kind: "bot" as const,
    id: template.id,
    name: template.name,
    blurb: template.blurb,
    installs: `Creates @${template.handle} in this workspace, with its persona, tools and triggers.`,
    tags: ["bot", ...(template.provider ? [template.provider] : []), ...template.tools],
    from: "packages/bots/src/templates.ts",
    handle: template.handle,
  }));
}

/**
 * The skills the bot templates carry, each on its own. A skill is the smallest thing worth
 * installing — it goes onto a bot that already exists, rather than bringing a whole bot with it.
 */
function skillItems(): HubItem[] {
  const out: HubItem[] = [];
  for (const template of BOT_TEMPLATES) {
    for (const skill of template.skills ?? []) {
      out.push({
        kind: "skill",
        id: skill.name,
        name: skill.name,
        blurb: skill.description,
        installs: "Adds this skill to a bot you choose; the bot keeps everything else it had.",
        tags: ["skill", template.handle],
        from: "packages/bots/src/templates.ts",
        parent: template.id,
        handle: template.handle,
      });
    }
  }
  return out;
}

function templateItems(): HubItem[] {
  return STACKS.map((stack) => ({
    kind: "template" as const,
    id: stack.id,
    name: stack.name,
    blurb: stack.description,
    installs: `Creates a project from this stack, ready to Start on port ${stack.port}.`,
    tags: ["template", ...stack.tags],
    from: "templates/src/stacks.ts",
    port: stack.port,
  }));
}

let cached: readonly HubItem[] | null = null;

/**
 * Everything in the index, by kind and then by name. Built once: the sources are compiled into the
 * binary, so the answer cannot change while the process is up.
 */
export function catalog(): readonly HubItem[] {
  if (cached) return cached;
  const order = new Map(HUB_KINDS.map((kind, index) => [kind, index]));
  const all = [...connectorItems(), ...botItems(), ...skillItems(), ...templateItems()].sort(
    (a, b) =>
      (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.name.localeCompare(b.name, "en"),
  );
  cached = Object.freeze(all);
  return cached;
}

/** One item, or undefined. Ids repeat across kinds, so both halves of the key are needed. */
export function hubItem(kind: string, id: string): HubItem | undefined {
  return catalog().find((one) => one.kind === kind && one.id === id);
}

/**
 * The index, filtered. `q` matches the name, the blurb and the tags — the three things somebody
 * types when they half-remember what they are looking for.
 */
export function searchHub(options: { kind?: string; q?: string } = {}): HubItem[] {
  const q = (options.q ?? "").trim().toLowerCase();
  return catalog().filter((item) => {
    if (options.kind && item.kind !== options.kind) return false;
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.blurb.toLowerCase().includes(q) ||
      item.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });
}

/** How many of each kind the index has, for the filter row. */
export function hubCounts(): Record<HubKind, number> {
  const counts = Object.fromEntries(HUB_KINDS.map((kind) => [kind, 0])) as Record<HubKind, number>;
  for (const item of catalog()) counts[item.kind] += 1;
  return counts;
}

export type { BotTemplate };
