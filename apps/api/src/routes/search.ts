/**
 * Search over REST (spec §7.1 `/api/workspaces/{ws}/search?q&type`; task 2.4).
 *
 * One endpoint for both kinds of result, because one search box asks one question. The filters are
 * the ones a person reaches for: this channel, this person, and which of the two kinds they want.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { SEARCH_TYPES, search } from "../services/search.ts";
import { fileBody, fileSchema } from "./files.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const blockSchema = z.looseObject({ type: z.string() });

const messageHitSchema = z
  .object({
    id: z.uuid(),
    channel_id: z.uuid(),
    channel_name: z.string().nullable(),
    thread_root_id: z.uuid().nullable(),
    author_type: z.enum(["user", "bot", "system"]),
    author_id: z.uuid(),
    author_name: z.string().nullable(),
    blocks: z.array(blockSchema),
    created_at: z.string(),
    rank: z.number(),
  })
  .openapi("MessageHit");

const fileHitSchema = z
  .object({
    file: fileSchema,
    channel_id: z.uuid().nullable(),
    channel_name: z.string().nullable(),
  })
  .openapi("FileHit");

const codeHitSchema = z
  .object({
    project_id: z.uuid(),
    project_name: z.string(),
    project_key: z.string(),
    path: z.string(),
    symbol: z.string().nullable(),
    start_line: z.number().int(),
    end_line: z.number().int(),
    content: z.string(),
    rank: z.number(),
  })
  .openapi("CodeHit");

const resultsSchema = z
  .object({
    messages: z.array(messageHitSchema),
    files: z.array(fileHitSchema),
    code: z.array(codeHitSchema),
  })
  .openapi("SearchResults");

const searchRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/search",
  tags: ["search"],
  summary: "Search the messages, files, and indexed code you can see",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ ws: z.uuid() }),
    query: z.object({
      q: z.string().min(1).max(200),
      type: z.enum(SEARCH_TYPES).optional(),
      channel: z.uuid().optional(),
      from: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: { description: "Results", content: { "application/json": { schema: resultsSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

export function registerSearch(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(searchRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const query = c.req.valid("query");
    await authorize(c, deps, "messages.read", { type: "workspace", id: ws });
    // The code lane reads projects, so it is authorized as projects are (task 2.17).
    if (query.type !== "messages" && query.type !== "files") {
      await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    }
    const user = currentUser(c);
    const results = await search(deps, {
      workspaceId: ws,
      userId: user.id,
      q: query.q,
      ...(query.type ? { type: query.type } : {}),
      ...(query.channel ? { channelId: query.channel } : {}),
      ...(query.from ? { authorId: query.from } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return c.json(
      {
        messages: results.messages.map((hit) => ({
          id: hit.message.id,
          channel_id: hit.channelId,
          channel_name: hit.channelName,
          thread_root_id: hit.message.threadRootId,
          author_type: hit.message.authorType,
          author_id: hit.message.authorId,
          author_name: hit.authorName,
          blocks: hit.message.blocks,
          created_at: hit.message.createdAt.toISOString(),
          rank: hit.rank,
        })),
        files: results.files.map((hit) => ({
          file: fileBody(hit.file),
          channel_id: hit.channelId,
          channel_name: hit.channelName,
        })),
        code: results.code.map((hit) => ({
          project_id: hit.projectId,
          project_name: hit.projectName,
          project_key: hit.projectKey,
          path: hit.path,
          symbol: hit.symbol,
          start_line: hit.startLine,
          end_line: hit.endLine,
          content: hit.content,
          rank: hit.score,
        })),
      },
      200,
    );
  });
}
