/**
 * Repo intelligence (spec §5.7 "codebase index (symbols + embeddings in pgvector) behind
 * @codebase; semantic search across code, chat, docs; generated repo docs and an AGENTS.md draft";
 * task 2.17).
 *
 * Indexing is: ask the runner what files the project has, read the ones worth reading, cut each
 * into chunks (`@perch/repo`), embed them when the workspace has a brain for it, and write the rows.
 * Asking is the other direction: the words always, the meaning too when there are vectors, and the
 * two lists merged so a hit that both halves found comes first.
 *
 * The embedding is optional on purpose (ADR-0110). A Perch with no embedding model still has an
 * index — the tsvector half — and `@codebase` still cites the right file; a workspace that names an
 * embedding brain also gets the half that finds a thing by what it does rather than by its name.
 */
import type { Bus } from "@perch/bus";
import type { Db, ModelProfile, Project, RepoChunk } from "@perch/db";
import type { RunnerLink } from "@perch/events";
import { EmbeddingError, embed } from "@perch/gateway";
import {
  agentsDraft,
  chunkFile,
  codebaseContext,
  indexable,
  mentionsCodebase,
  questionOf,
  type RepoFacts,
} from "@perch/repo";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { listProfiles } from "../repos/brains.ts";
import {
  dropOtherCommits,
  type Hit,
  type IndexedChunk,
  type IndexStatus,
  indexStatus,
  insertChunks,
  searchVector,
  searchWords,
} from "../repos/repo-index.ts";
import type { BrainsService } from "./brains.ts";
import { getProject } from "./projects.ts";
import { runnerCall } from "./runners.ts";

/** The queue an index pass runs on, so reading a repository never happens inside a request. */
export const REPO_INDEX_QUEUE = "repo-index";

/** Files bigger than this are skipped: a generated bundle is not what `@codebase` is for. */
const MAX_FILE_BYTES = 400_000;
/** How many files one index pass reads. A repository larger than this indexes its first slice. */
const MAX_FILES = 3_000;
/** How many chunks go to the embedding provider in one request. */
const EMBED_BATCH = 64;

export type RepoIndexDeps = {
  db: Db;
  bus: Bus;
  brains: BrainsService;
  log: Logger;
};

export type IndexResult = {
  commitSha: string;
  files: number;
  chunks: number;
  embedded: number;
  /** Why nothing was embedded, when nothing was: no brain, or the provider refused. */
  embeddingSkipped?: string;
};

type FsEntry = { path: string; size: number };

/** `fs.list` answers with names inside a directory (§7.6); the path is the walk's to keep. */
type Listed = { name: string; type: "file" | "dir" | "symlink" | "other"; size: number };

async function listDir(
  link: RunnerLink,
  input: { workspaceId: string; userId: string; projectId: string },
  at: string,
): Promise<Listed[]> {
  const raw = (await runnerCall(link, "fs.list", {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    project: input.projectId,
    path: at,
  })) as { entries?: { name?: unknown; type?: unknown; size?: unknown }[] };
  const out: Listed[] = [];
  for (const entry of raw.entries ?? []) {
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!name) continue;
    const type =
      entry.type === "dir" || entry.type === "symlink" || entry.type === "other"
        ? entry.type
        : "file";
    out.push({ name, type, size: typeof entry.size === "number" ? entry.size : 0 });
  }
  return out;
}

/**
 * Every file in the project, flat. Breadth-first so a repository past `MAX_FILES` indexes its
 * shallowest files — the ones an answer is most often about — rather than one deep branch of it.
 */
async function walk(
  link: RunnerLink,
  input: { workspaceId: string; userId: string; projectId: string },
): Promise<FsEntry[]> {
  const found: FsEntry[] = [];
  const queue: string[] = ["."];
  while (queue.length > 0 && found.length < MAX_FILES) {
    const at = queue.shift() ?? ".";
    const entries = await listDir(link, input, at).catch(() => [] as Listed[]);
    for (const entry of entries) {
      const path = at === "." ? entry.name : `${at}/${entry.name}`;
      if (entry.type === "dir") {
        // `indexable` decides on files; a directory is only pruned when its name is one to skip.
        if (indexable(`${path}/x.ts`)) queue.push(path);
        continue;
      }
      // A symlink is followed by whatever it points at, which is already in this walk or outside it.
      if (entry.type !== "file") continue;
      if (!indexable(path) || entry.size > MAX_FILE_BYTES) continue;
      found.push({ path, size: entry.size });
    }
  }
  return found;
}

export class RepoIndexService {
  constructor(private readonly deps: RepoIndexDeps) {}

  status(projectId: string): Promise<IndexStatus> {
    return indexStatus(this.deps.db, projectId);
  }

  /** The brain a workspace embeds with, when it has named one. */
  async embeddingProfile(workspaceId: string): Promise<ModelProfile | null> {
    const profiles = await listProfiles(this.deps.db, workspaceId);
    return profiles.find((one) => one.defaultFor === "embedding") ?? null;
  }

  /**
   * One pass over a project. The whole index for the commit is written before the older commit's
   * rows are dropped, so a search during a reindex finds the old answer rather than none.
   */
  async index(input: {
    project: Project;
    link: RunnerLink;
    userId: string;
    by: ActorContext;
  }): Promise<IndexResult> {
    const { project } = input;
    const commitSha = project.head ?? "working";
    const files = await walk(input.link, {
      workspaceId: project.workspaceId,
      userId: input.userId,
      projectId: project.id,
    });

    const chunks: IndexedChunk[] = [];
    for (const file of files) {
      const read = (await runnerCall(input.link, "fs.read", {
        workspace_id: project.workspaceId,
        user_id: input.userId,
        project: project.id,
        path: file.path,
      }).catch(() => null)) as {
        content?: unknown;
        encoding?: unknown;
        truncated?: unknown;
      } | null;
      if (!read || typeof read.content !== "string" || read.encoding === "base64") continue;
      let chunkNo = 0;
      for (const piece of chunkFile(file.path, read.content)) {
        chunks.push({
          projectId: project.id,
          commitSha,
          path: file.path,
          chunkNo: chunkNo++,
          kind: piece.kind,
          symbol: piece.symbol ?? null,
          startLine: piece.startLine,
          endLine: piece.endLine,
          content: piece.content,
        });
      }
    }

    const embedded = await this.addEmbeddings(project.workspaceId, input.userId, chunks);
    await insertChunks(this.deps.db, chunks);
    await dropOtherCommits(this.deps.db, project.id, commitSha);

    const result: IndexResult = {
      commitSha,
      files: files.length,
      chunks: chunks.length,
      embedded: embedded.count,
      ...(embedded.skipped ? { embeddingSkipped: embedded.skipped } : {}),
    };
    await this.deps.bus.publish(
      "project.updated",
      {
        workspaceId: project.workspaceId,
        projectId: project.id,
        changes: [`index:${result.chunks}`],
      },
      input.by,
    );
    return result;
  }

  /** The draft, written into the project, where an engine reads it at the start of a session. */
  async writeDraft(input: {
    project: Project;
    link: RunnerLink;
    userId: string;
    markdown: string;
  }): Promise<void> {
    await runnerCall(input.link, "fs.write", {
      workspace_id: input.project.workspaceId,
      user_id: input.userId,
      project: input.project.id,
      path: "AGENTS.md",
      content: input.markdown,
      encoding: "utf8",
    });
  }

  /**
   * The vectors, when the workspace has a brain for them. A provider that refuses does not fail the
   * index: the rows go in with no embedding and the words still find them.
   */
  private async addEmbeddings(
    workspaceId: string,
    userId: string,
    chunks: IndexedChunk[],
  ): Promise<{ count: number; skipped?: string }> {
    if (chunks.length === 0) return { count: 0 };
    const profile = await this.embeddingProfile(workspaceId);
    if (!profile) {
      return { count: 0, skipped: "no brain is the workspace's embedding model" };
    }
    const credential = profile.credentialId
      ? await this.deps.brains.credentialFor(workspaceId, userId, profile.credentialId)
      : null;
    if (profile.credentialId && !credential) {
      return { count: 0, skipped: "that embedding brain's credential is not this caller's to use" };
    }
    const apiKey = credential ? await this.deps.brains.secretOf(credential) : null;
    let count = 0;
    for (let at = 0; at < chunks.length; at += EMBED_BATCH) {
      const slice = chunks.slice(at, at + EMBED_BATCH);
      try {
        const vectors = await embed({
          provider: credential?.provider ?? profile.provider,
          model: profile.modelId,
          input: slice.map((one) =>
            one.symbol
              ? `${one.path} ${one.symbol}\n${one.content}`
              : `${one.path}\n${one.content}`,
          ),
          ...(credential?.baseUrl ? { baseUrl: credential.baseUrl } : {}),
          ...(apiKey ? { apiKey } : {}),
        });
        for (let i = 0; i < slice.length; i++) {
          const chunk = slice[i];
          const vector = vectors[i];
          if (chunk && vector) {
            chunk.embedding = vector;
            count += 1;
          }
        }
      } catch (error) {
        // Never repeat the request: it carried a key. The index is still written, without vectors.
        const why = error instanceof EmbeddingError ? error.message : "the embedding call failed";
        this.deps.log.warn({ workspaceId, err: error }, "embedding a repository failed");
        return { count, skipped: why };
      }
    }
    return { count };
  }

  /**
   * What the index knows about a question. The words and the meaning are asked separately and then
   * merged: a chunk both halves found is more likely to be the answer than one either found alone.
   */
  async search(input: {
    project: Project;
    userId: string;
    query: string;
    limit?: number;
  }): Promise<Hit[]> {
    const query = input.query.trim();
    if (!query) return [];
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);
    const words = await searchWords(this.deps.db, {
      projectId: input.project.id,
      query,
      limit: limit * 2,
    });
    const vectors = await this.searchByMeaning(input, limit * 2);
    return merge(words, vectors).slice(0, limit);
  }

  private async searchByMeaning(
    input: { project: Project; userId: string; query: string },
    limit: number,
  ): Promise<Hit[]> {
    const profile = await this.embeddingProfile(input.project.workspaceId);
    if (!profile) return [];
    try {
      const credential = profile.credentialId
        ? await this.deps.brains.credentialFor(
            input.project.workspaceId,
            input.userId,
            profile.credentialId,
          )
        : null;
      const apiKey = credential ? await this.deps.brains.secretOf(credential) : null;
      const [vector] = await embed({
        provider: credential?.provider ?? profile.provider,
        model: profile.modelId,
        input: [input.query],
        ...(credential?.baseUrl ? { baseUrl: credential.baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      if (!vector) return [];
      return await searchVector(this.deps.db, {
        projectId: input.project.id,
        embedding: vector,
        limit,
      });
    } catch (error) {
      // A question still gets an answer from the words when the provider is down.
      this.deps.log.debug({ err: error }, "searching by meaning failed");
      return [];
    }
  }

  /**
   * The AGENTS.md a project is offered (spec §5.7). Built from what the repository shows — its
   * layout, its scripts, its README — with the judgement calls left as prompts for a person.
   */
  async agentsDraft(input: {
    project: Project;
    link: RunnerLink;
    userId: string;
  }): Promise<string> {
    const { project } = input;
    const entries = await listDir(
      input.link,
      { workspaceId: project.workspaceId, userId: input.userId, projectId: project.id },
      ".",
    );
    const rootFiles: string[] = [];
    const directories: string[] = [];
    for (const entry of entries) {
      // A dot file is Perch's or the tool's, not the project's, and says nothing about the work.
      if (entry.name.startsWith(".")) continue;
      if (entry.type === "dir") {
        if (indexable(`${entry.name}/x.ts`)) directories.push(entry.name);
      } else if (entry.type === "file" && indexable(entry.name)) {
        rootFiles.push(entry.name);
      }
    }

    const read = async (path: string): Promise<string | null> => {
      const answer = (await runnerCall(input.link, "fs.read", {
        workspace_id: project.workspaceId,
        user_id: input.userId,
        project: project.id,
        path,
      }).catch(() => null)) as { content?: unknown } | null;
      return typeof answer?.content === "string" ? answer.content : null;
    };

    const facts: RepoFacts = {
      name: project.name,
      rootFiles: rootFiles.sort(),
      directories: directories.sort(),
    };
    const manifest = rootFiles.includes("package.json") ? await read("package.json") : null;
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest) as { scripts?: Record<string, unknown> };
        const scripts: Record<string, string> = {};
        for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
          if (typeof command === "string") scripts[name] = command;
        }
        if (Object.keys(scripts).length > 0) facts.scripts = scripts;
      } catch {
        // A package.json that does not parse says nothing about the commands.
      }
    }
    const readmePath = rootFiles.find((one) => /^readme(\.md)?$/i.test(one));
    if (readmePath) {
      const readme = await read(readmePath);
      const paragraph = (readme ?? "")
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join("\n")
        .trim()
        .split("\n\n")[0];
      if (paragraph) facts.readme = paragraph.slice(0, 600);
    }
    return agentsDraft(facts);
  }
}

/**
 * Two ranked lists into one. Each list's own rank is what it contributes — reciprocal rank fusion,
 * which needs no shared scale between "how well the words matched" and "how near the vectors are".
 */
export function merge(words: readonly Hit[], vectors: readonly Hit[], k = 60): Hit[] {
  const scores = new Map<string, { hit: Hit; score: number }>();
  const add = (list: readonly Hit[]) => {
    for (let at = 0; at < list.length; at++) {
      const hit = list[at];
      if (!hit) continue;
      const found = scores.get(hit.id);
      const score = 1 / (k + at + 1);
      if (found) found.score += score;
      else scores.set(hit.id, { hit, score });
    }
  };
  add(words);
  add(vectors);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((one) => ({ ...one.hit, score: one.score }));
}

/** A hit as `@codebase` and the search page both want it. */
export function hitView(hit: RepoChunk & { score?: number }) {
  return {
    path: hit.path,
    symbol: hit.symbol,
    kind: hit.kind,
    start_line: hit.startLine,
    end_line: hit.endLine,
    content: hit.content,
    score: hit.score ?? 0,
  };
}

/** The project a `@codebase` turn is about must be indexed before it can answer. */
export function requireIndexed(status: IndexStatus): void {
  if (status.chunks === 0) {
    throw PerchError.conflict("this project has not been indexed yet", { rule: "index.empty" });
  }
}

/**
 * What `@codebase` puts in front of the engine (spec §5.7; task 2.17), or `""` when there is
 * nothing to put there. A turn that does not say `@codebase` is never searched for — the index is
 * asked for, not assumed — and one that does gets the places it names, each citing its file and
 * lines.
 *
 * This is deliberately separate from the turn itself (ADR-0110): the transcript keeps the person's
 * words, and the context rides alongside them to the engine. An index that is empty, or a search
 * that fails, returns `""` — an agent that has to look for itself is worse off than one that was
 * handed the file, and better off than one that was handed an error.
 */
export async function codebaseContextFor(
  deps: { db: Db; repoIndex: RepoIndexService; log: Logger },
  session: { workspaceId: string; projectId: string },
  userId: string,
  text: string,
): Promise<string> {
  if (!mentionsCodebase(text)) return "";
  try {
    const project = await getProject(deps.db, session.workspaceId, session.projectId);
    if (!project) return "";
    const hits = await deps.repoIndex.search({
      project,
      userId,
      query: questionOf(text),
      limit: 6,
    });
    return codebaseContext(
      hits.map((hit) => ({
        path: hit.path,
        startLine: hit.startLine,
        endLine: hit.endLine,
        content: hit.content,
        symbol: hit.symbol,
      })),
    );
  } catch (error) {
    deps.log.debug({ err: error }, "@codebase context could not be built");
    return "";
  }
}
