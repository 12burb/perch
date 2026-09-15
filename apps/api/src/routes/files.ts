/**
 * Files over REST (spec §7.1 `/api/workspaces/{ws}/files` multipart, `/api/files/{id}` and its
 * `/preview`; task 2.3).
 *
 * The upload is a plain multipart form, because that is what a file input and a phone's share
 * sheet both send. What comes back is metadata; the bytes are a second request, so a transcript
 * can decide for itself what it draws and what it only names.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { FileRow } from "@perch/db";
import { authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { canReadFile, visibleChannelIds } from "../repos/search.ts";
import { bodyOf, getFile, isInline, MAX_UPLOAD_BYTES, storeUpload } from "../services/files.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

export const fileSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int(),
    /** True when a browser may draw it inline; false when it is only ever a download. */
    preview: z.boolean(),
    uploaded_at: z.string(),
  })
  .openapi("File");

export function fileBody(row: FileRow) {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    preview: row.previewKey !== null,
    uploaded_at: row.createdAt.toISOString(),
  };
}

const uploadRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/files",
  tags: ["files"],
  summary: "Upload a file",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ ws: z.uuid() }),
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "The file", content: { "application/json": { schema: fileSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const downloadRoute = createRoute({
  method: "get",
  path: "/api/files/{id}",
  tags: ["files"],
  summary: "The file itself, as a download",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "The bytes", content: { "application/octet-stream": { schema: z.any() } } },
    ...errorResponses(403, 404),
  },
});

const previewRoute = createRoute({
  method: "get",
  path: "/api/files/{id}/preview",
  tags: ["files"],
  summary: "The file as something to look at, when it is one",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "The bytes", content: { "image/*": { schema: z.any() } } },
    ...errorResponses(403, 404),
  },
});

/** A filename in a header, said both ways, because names have quotes and accents in them. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerFiles(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /**
   * Seeing a file is being in its workspace *and* having somewhere to have seen it: your own
   * upload, or a message in a channel you can see (task 2.4, ADR-0094). A file you have no way to
   * have come across is not there as far as you are concerned, which is the answer a private
   * channel gives about everything else of its own.
   */
  const fileFor = async (c: Parameters<typeof authorize>[0], id: string): Promise<FileRow> => {
    const row = await getFile(deps.db.db, id);
    if (!row) throw PerchError.notFound("file");
    await authorize(c, deps, "files.read", { type: "workspace", id: row.workspaceId });
    const userId = currentUser(c).id;
    const scope = await visibleChannelIds(deps.db.db, row.workspaceId, userId);
    if (!(await canReadFile(deps.db.db, row, userId, scope))) throw PerchError.notFound("file");
    return row;
  };

  app.openapi(uploadRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "files.write", { type: "workspace", id: ws });
    // The validator has already read the body, so the file comes from there, not a second read.
    const { file } = c.req.valid("form");
    if (!(file instanceof File)) throw PerchError.validation("send a file under `file`");
    const row = await storeUpload(deps, {
      workspaceId: ws,
      uploader: { type: "user", id: currentUser(c).id },
      file,
    });
    return c.json(fileBody(row), 201);
  });

  app.openapi(downloadRoute, async (c) => {
    const row = await fileFor(c, c.req.valid("param").id);
    // Everything downloads. Nothing an upload says about itself makes a browser run it here.
    return new Response(bodyOf(deps, row), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(Number(row.size)),
        "content-disposition": disposition("attachment", row.name),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    });
  });

  app.openapi(previewRoute, async (c) => {
    const row = await fileFor(c, c.req.valid("param").id);
    // Only the image types a browser draws without running anything are served as themselves.
    if (!row.previewKey || !isInline(row.mime)) throw PerchError.notFound("preview");
    return new Response(bodyOf(deps, row), {
      headers: {
        "content-type": row.mime,
        "content-length": String(Number(row.size)),
        "content-disposition": disposition("inline", row.name),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    });
  });
}

export { MAX_UPLOAD_BYTES };
