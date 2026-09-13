import type { Db, User } from "@perch/db";
import { PerchError } from "../errors.ts";
import { findUserByAuthUserId, handleTaken, insertUser, updateUser } from "../repos/users.ts";

/** A handle from an email's local part: lowercase letters, digits, dashes; 2..32 characters. */
export function handleFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned.length >= 2 ? cleaned : `user-${cleaned}`.slice(0, 32);
}

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

async function uniqueHandle(db: Db, base: string): Promise<string> {
  if (!(await handleTaken(db, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 32 - String(i).length - 1)}-${i}`;
    if (!(await handleTaken(db, candidate))) return candidate;
  }
  return `${base.slice(0, 20)}-${Bun.randomUUIDv7().slice(-8)}`;
}

/** Creates the Perch profile row for an auth user once (better-auth's databaseHooks call this). */
export async function ensureProfile(
  db: Db,
  input: { authUserId: string; email: string; name: string | null | undefined },
): Promise<User> {
  const existing = await findUserByAuthUserId(db, input.authUserId);
  if (existing) return existing;
  const handle = await uniqueHandle(db, handleFromEmail(input.email));
  const name = input.name?.trim() || (input.email.split("@")[0] ?? "user");
  const inserted = await insertUser(db, {
    authUserId: input.authUserId,
    email: input.email,
    name,
    handle,
  });
  if (inserted) return inserted;
  const raced = await findUserByAuthUserId(db, input.authUserId);
  if (!raced) throw new Error("profile row missing after insert");
  return raced;
}

export async function updateProfile(
  db: Db,
  user: User,
  patch: { name?: string; handle?: string; locale?: string; tz?: string },
): Promise<User> {
  if (patch.handle !== undefined && patch.handle !== user.handle) {
    if (!HANDLE_PATTERN.test(patch.handle)) {
      throw PerchError.validation("handle must be 2-32 lowercase letters, digits, or dashes");
    }
    if (await handleTaken(db, patch.handle)) throw PerchError.conflict("handle is taken");
  }
  const updated = await updateUser(db, user.id, patch);
  if (!updated) throw PerchError.notFound("user");
  return updated;
}
