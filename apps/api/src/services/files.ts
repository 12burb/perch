/**
 * Files (spec §5.2 "file uploads with previews", §6 `files`, §7.1 `/api/workspaces/{ws}/files`;
 * task 2.3). An upload lands on the instance's own volume — `PERCH_FILES_DIR`, spec §3.1, no
 * object store to run — and a row in `files` says what it is and who put it there.
 *
 * What comes back out is deliberately dull: everything downloads as an attachment except the image
 * types a browser can draw without running anything, and nothing is ever sniffed (ADR-0093).
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db, FileRow, MessageBlock } from "@perch/db";
import { schema } from "@perch/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { PerchError } from "../errors.ts";

const { files } = schema;

/** As big as one upload may be. A chat is not a backup target. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The types served inline from Perch's own origin. Everything else — SVG and HTML above all, which
 * carry script — downloads instead, so an upload can never run in a reader's session.
 */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export function isInline(mime: string): boolean {
  return INLINE_TYPES.has(mime.split(";")[0]?.trim().toLowerCase() ?? "");
}

/**
 * A name that is only a name: no directories, no control characters, never empty. A browser that
 * posts an empty part sends no filename at all, so this takes whatever arrives.
 */
export function safeName(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const printable = [...base].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  const cleaned = printable.join("").trim();
  return cleaned.slice(0, 200) || "file";
}

export type FileDeps = { db: { db: Db }; env: { filesDir: string } };

export type UploadInput = {
  workspaceId: string;
  uploader: { type: "user" | "bot"; id: string };
  file: File;
};

/** Where a stored file lives. The key is a uuid, so nothing a caller says reaches the path. */
function pathOf(deps: FileDeps, storageKey: string): string {
  return join(deps.env.filesDir, storageKey);
}

export async function storeUpload(deps: FileDeps, input: UploadInput): Promise<FileRow> {
  const size = input.file.size;
  if (!size || size <= 0) throw PerchError.validation("that file is empty");
  const name = safeName(input.file.name);
  if (size > MAX_UPLOAD_BYTES) {
    throw PerchError.validation(
      `that file is bigger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`,
    );
  }
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const mime = (input.file.type || "application/octet-stream").split(";")[0]?.trim().toLowerCase();
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  // One path per upload: two people may send the same bytes under different names, and each keeps
  // the name they sent. Dedup by `sha256` is an optimization for later, not a shared row now.
  const storageKey = `${input.workspaceId}/${sha256.slice(0, 2)}/${crypto.randomUUID()}`;
  const target = pathOf(deps, storageKey);
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, bytes);

  const [row] = await deps.db.db
    .insert(files)
    .values({
      workspaceId: input.workspaceId,
      uploaderType: input.uploader.type,
      uploaderId: input.uploader.id,
      storageKey,
      name,
      mime: mime || "application/octet-stream",
      size,
      sha256,
      // The preview of an image is the image: nothing is re-encoded, and a type a browser cannot
      // draw safely has no preview at all.
      previewKey: isInline(mime ?? "") ? storageKey : null,
    })
    .returning();
  if (!row) throw new Error("file insert returned no row");
  return row;
}

export async function getFile(db: Db, id: string): Promise<FileRow | null> {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The file ids a message's blocks point at, in the order the blocks are in. */
export function fileIdsIn(rows: { blocks: MessageBlock[] }[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    for (const block of row.blocks) {
      if (block.type !== "file") continue;
      if (!ids.includes(block.fileId)) ids.push(block.fileId);
    }
  }
  return ids;
}

/** The files a page of messages points at, for the client to draw without asking again. */
export async function filesByIds(db: Db, ids: string[]): Promise<Map<string, FileRow>> {
  const out = new Map<string, FileRow>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, ids), isNull(files.deletedAt)));
  for (const row of rows) out.set(row.id, row);
  return out;
}

/** The bytes, as something a Response can stream. */
export function bodyOf(deps: FileDeps, row: FileRow): ReturnType<typeof Bun.file> {
  return Bun.file(pathOf(deps, row.storageKey));
}
