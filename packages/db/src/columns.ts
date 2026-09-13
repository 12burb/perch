import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import { newId } from "./id.ts";

/** Case-insensitive text (the citext extension); used for emails, handles, slugs, keys, channel names. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

/** Binary secrets: vault ciphertext. postgres.js hands back a Buffer, PGlite a Uint8Array. */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
  },
});

/** Full-text search vectors; always a generated column. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/** Every table: id uuid (v7) primary key. */
export const id = () => uuid("id").primaryKey().$defaultFn(newId);

/** Every table: created_at and updated_at timestamptz. */
export const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
