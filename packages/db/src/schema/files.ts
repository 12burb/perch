import { bigint, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamps, timestamptz } from "../columns.ts";
import { workspaces } from "./tenancy.ts";

export const files = pgTable(
  "files",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    uploaderType: text("uploader_type").notNull(),
    uploaderId: uuid("uploader_id").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    previewKey: text("preview_key"),
    deletedAt: timestamptz("deleted_at"),
    ...timestamps(),
  },
  (t) => [index("files_workspace_created_idx").on(t.workspaceId, t.createdAt.desc())],
);

export type FileRow = typeof files.$inferSelect;
