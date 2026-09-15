/**
 * Search, the rules around the query (spec §5.2, §7.1; task 2.4).
 *
 * The repository knows how to match; this decides what a caller is allowed to match against. A
 * channel filter has to be a channel they can see — named through `channelFor`, so an invisible one
 * answers 404 exactly as it does everywhere else (ADR-0090) rather than quietly returning nothing.
 */
import type { Bus } from "@perch/bus";
import type { Db } from "@perch/db";
import { PerchError } from "../errors.ts";
import { type CodeHit, searchWorkspaceWords } from "../repos/repo-index.ts";
import {
  type FileHit,
  type MessageHit,
  searchFiles,
  searchMessages,
  visibleChannelIds,
} from "../repos/search.ts";
import { channelFor } from "./channels.ts";

/** `channelFor` refuses a channel the way the channel routes do, so the bus comes with it. */
export type SearchDeps = { db: { db: Db }; bus: Bus };

export const SEARCH_TYPES = ["all", "messages", "files", "code"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export type SearchInput = {
  workspaceId: string;
  userId: string;
  q: string;
  type?: SearchType | undefined;
  channelId?: string | undefined;
  authorId?: string | undefined;
  limit?: number | undefined;
};

export type SearchResults = { messages: MessageHit[]; files: FileHit[]; code: CodeHit[] };

/** A query has to be something: one character is a scan of everything, not a search. */
export function parseQuery(raw: string): string {
  const q = raw.trim();
  if (q.length < 2) throw PerchError.validation("search for at least two characters");
  if (q.length > 200) throw PerchError.validation("that search is too long");
  return q;
}

export async function search(deps: SearchDeps, input: SearchInput): Promise<SearchResults> {
  const q = parseQuery(input.q);
  const type = input.type ?? "all";
  const visible = await visibleChannelIds(deps.db.db, input.workspaceId, input.userId);
  let scope = visible;
  if (input.channelId) {
    // Refused the way the channel itself would be, rather than as an empty result.
    const channel = await channelFor(deps, input.workspaceId, input.channelId, input.userId);
    scope = [channel.id];
  }

  const messages =
    type === "files" || type === "code"
      ? []
      : await searchMessages(deps.db.db, {
          workspaceId: input.workspaceId,
          q,
          scope,
          ...(input.authorId ? { authorId: input.authorId } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        });
  const files =
    type === "messages" || type === "code"
      ? []
      : await searchFiles(deps.db.db, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          q,
          scope,
          ...(input.limit ? { limit: input.limit } : {}),
        });
  // The code lane never narrows to a channel: an index belongs to a project, not a conversation.
  const code =
    type === "messages" || type === "files" || input.channelId
      ? []
      : await searchWorkspaceWords(deps.db.db, {
          workspaceId: input.workspaceId,
          query: q,
          limit: input.limit ?? 20,
        });
  return { messages, files, code };
}
