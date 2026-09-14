import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "../src/client.ts";
import * as schema from "../src/schema/index.ts";
import { messageBlocksSchema, projectConfigSchema } from "../src/shapes/index.ts";
import { createPostgresTestDb, createTestDb } from "../src/testing.ts";

/**
 * Task 0.5 acceptance: schema tests pass on both drivers. The suite below runs on PGlite in memory
 * always, and on Postgres when PERCH_TEST_DATABASE_URL points at a throwaway database (CI service
 * container).
 */

/**
 * Asserts a query fails and that the driver's reason (drizzle wraps it as `cause`) matches the pattern.
 * Drizzle queries are thenables rather than Promises, so this awaits them directly.
 */
async function fails(query: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  try {
    await query;
  } catch (error) {
    const err = error as Error & { cause?: { message?: string } };
    expect(`${err.message} ${err.cause?.message ?? ""}`).toMatch(pattern);
    return;
  }
  throw new Error("expected the query to fail");
}

function schemaSuite(name: string, open: () => Promise<DbHandle | null>) {
  describe(`schema on ${name}`, () => {
    let handle: DbHandle | null = null;
    let skipped = false;

    beforeAll(async () => {
      handle = await open();
      skipped = handle === null;
    }, 60_000);

    afterAll(async () => {
      await handle?.close();
    }, 30_000);

    const db = () => {
      if (!handle) throw new Error("no database");
      return handle.db;
    };

    test("migrations are idempotent: a second run applies nothing", async () => {
      if (skipped) return;
      if (!handle) throw new Error("no database");
      const again = await handle.migrate();
      expect(again.applied).toBe(0);
      expect(again.total).toBeGreaterThanOrEqual(2);
    });

    test("ids are uuid v7 and timestamps default", async () => {
      if (skipped) return;
      const [ws] = await db()
        .insert(schema.workspaces)
        .values({ slug: "Nest", name: "The Nest" })
        .returning();
      expect(ws?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(ws?.createdAt).toBeInstanceOf(Date);
      expect(ws?.plan).toBe("self-hosted");
      expect(ws?.settings).toEqual({});
    });

    test("citext: slugs, emails, and handles compare case-insensitively and stay unique", async () => {
      if (skipped) return;
      const found = await db()
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.slug, "nest"));
      expect(found).toHaveLength(1);
      await fails(
        db().insert(schema.workspaces).values({ slug: "NEST", name: "dup" }),
        /unique|duplicate/i,
      );

      await db()
        .insert(schema.authUser)
        .values({ id: "au_1", name: "Dawn", email: "dawn@example.test" });
      const [user] = await db()
        .insert(schema.users)
        .values({ authUserId: "au_1", email: "Dawn@Example.test", name: "Dawn", handle: "Dawn" })
        .returning();
      expect(user?.locale).toBe("en");
      const byHandle = await db()
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.handle, "dAWN"));
      expect(byHandle[0]?.id).toBe(user?.id);
    });

    test("check constraints reject values outside the enum", async () => {
      if (skipped) return;
      const ws = (await db().select().from(schema.workspaces).limit(1))[0];
      const user = (await db().select().from(schema.users).limit(1))[0];
      if (!ws || !user) throw new Error("fixtures missing");
      await fails(
        db()
          .insert(schema.memberships)
          .values({ workspaceId: ws.id, userId: user.id, role: "guest" as "member" }),
        /check|violates/i,
      );
      await db()
        .insert(schema.memberships)
        .values({ workspaceId: ws.id, userId: user.id, role: "owner" });
      await fails(
        db()
          .insert(schema.memberships)
          .values({ workspaceId: ws.id, userId: user.id, role: "admin" }),
        /unique|duplicate/i,
      );
    });

    test("channels: the partial unique index allows unnamed DMs and rejects duplicate names", async () => {
      if (skipped) return;
      const ws = (await db().select().from(schema.workspaces).limit(1))[0];
      if (!ws) throw new Error("fixtures missing");
      await db()
        .insert(schema.channels)
        .values({ workspaceId: ws.id, type: "public", name: "general" });
      await fails(
        db()
          .insert(schema.channels)
          .values({ workspaceId: ws.id, type: "public", name: "General" }),
        /unique|duplicate/i,
      );
      await db()
        .insert(schema.channels)
        .values([
          { workspaceId: ws.id, type: "dm" },
          { workspaceId: ws.id, type: "dm" },
        ]);
      await fails(
        db()
          .insert(schema.channels)
          .values({ workspaceId: ws.id, type: "voice" as "public" }),
        /check|violates/i,
      );
    });

    test("messages: blocks are jsonb, text_search is generated, threads reference the root", async () => {
      if (skipped) return;
      const ws = (await db().select().from(schema.workspaces).limit(1))[0];
      const user = (await db().select().from(schema.users).limit(1))[0];
      const channel = (
        await db().select().from(schema.channels).where(eq(schema.channels.name, "general"))
      )[0];
      if (!ws || !user || !channel) throw new Error("fixtures missing");
      const blocks = messageBlocksSchema.parse([
        { type: "text", text: "the agent opened a pull request" },
        { type: "code", code: "git push origin perch/NEST-1", language: "sh" },
      ]);
      const [root] = await db()
        .insert(schema.messages)
        .values({
          workspaceId: ws.id,
          channelId: channel.id,
          authorType: "user",
          authorId: user.id,
          blocks,
        })
        .returning();
      if (!root) throw new Error("insert failed");
      expect(root.replyCount).toBe(0);
      expect(root.blocks).toEqual(blocks);

      const [reply] = await db()
        .insert(schema.messages)
        .values({
          workspaceId: ws.id,
          channelId: channel.id,
          threadRootId: root.id,
          authorType: "bot",
          authorId: user.id,
          blocks: [{ type: "text", text: "on it" }],
        })
        .returning();
      expect(reply?.threadRootId).toBe(root.id);

      const hits = await db()
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(sql`${schema.messages.textSearch} @@ plainto_tsquery('english', 'pull requests')`);
      expect(hits.map((h) => h.id)).toEqual([root.id]);
      const codeHits = await db()
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(sql`${schema.messages.textSearch} @@ plainto_tsquery('english', 'origin')`);
      expect(codeHits.map((h) => h.id)).toEqual([root.id]);

      await db()
        .insert(schema.messageReactions)
        .values({ messageId: root.id, memberType: "user", memberId: user.id, emoji: "👀" });
      await fails(
        db()
          .insert(schema.messageReactions)
          .values({ messageId: root.id, memberType: "user", memberId: user.id, emoji: "👀" }),
        /unique|duplicate/i,
      );
      await db()
        .insert(schema.threadFacts)
        .values({
          threadRootId: root.id,
          key: "pr",
          value: { url: "https://example.test/pr/1" },
          updatedByType: "bot",
          updatedById: user.id,
        });
    });

    test("project_env stores bytea ciphertext and files carry bigint sizes", async () => {
      if (skipped) return;
      const ws = (await db().select().from(schema.workspaces).limit(1))[0];
      const user = (await db().select().from(schema.users).limit(1))[0];
      if (!ws || !user) throw new Error("fixtures missing");
      const [project] = await db()
        .insert(schema.projects)
        .values({
          workspaceId: ws.id,
          key: "NEST",
          name: "Nest",
          config: projectConfigSchema.parse({ preview: { command: "bun dev", port: 5173 } }),
        })
        .returning();
      if (!project) throw new Error("insert failed");
      expect(project.defaultBranch).toBe("main");
      const ciphertext = new Uint8Array([1, 2, 3, 250, 251, 252]);
      await db()
        .insert(schema.projectEnv)
        .values({ projectId: project.id, key: "DATABASE_URL", ciphertext, source: "manual" });
      const [env] = await db()
        .select()
        .from(schema.projectEnv)
        .where(eq(schema.projectEnv.projectId, project.id));
      expect(Array.from(env?.ciphertext ?? [])).toEqual([1, 2, 3, 250, 251, 252]);
      await fails(
        db()
          .insert(schema.projectEnv)
          .values({ projectId: project.id, key: "DATABASE_URL", ciphertext, source: "manual" }),
        /unique|duplicate/i,
      );

      const [file] = await db()
        .insert(schema.files)
        .values({
          workspaceId: ws.id,
          uploaderType: "user",
          uploaderId: user.id,
          storageKey: `ws/${ws.id}/f1`,
          name: "big.bin",
          mime: "application/octet-stream",
          size: 5_000_000_000,
          sha256: "0".repeat(64),
        })
        .returning();
      expect(file?.size).toBe(5_000_000_000);
    });

    test("instance_settings is a key/value store with jsonb values", async () => {
      if (skipped) return;
      await db()
        .insert(schema.instanceSettings)
        .values({ key: "telemetry", value: { enabled: false } })
        .onConflictDoUpdate({
          target: schema.instanceSettings.key,
          set: { value: { enabled: false } },
        });
      await db()
        .insert(schema.instanceSettings)
        .values({ key: "telemetry", value: { enabled: true } })
        .onConflictDoUpdate({
          target: schema.instanceSettings.key,
          set: { value: { enabled: true } },
        });
      const rows = await db().select().from(schema.instanceSettings);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toEqual({ enabled: true });
    });

    test("deleting a workspace cascades through memberships, channels, and messages", async () => {
      if (skipped) return;
      const ws = (await db().select().from(schema.workspaces).limit(1))[0];
      if (!ws) throw new Error("fixtures missing");
      await db().delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
      expect(await db().select().from(schema.memberships)).toHaveLength(0);
      expect(await db().select().from(schema.channels)).toHaveLength(0);
      expect(await db().select().from(schema.messages)).toHaveLength(0);
      expect(await db().select().from(schema.threadFacts)).toHaveLength(0);
      expect(await db().select().from(schema.users)).toHaveLength(1);
    });
  });
}

schemaSuite("pglite (in memory)", createTestDb);
schemaSuite("postgres (PERCH_TEST_DATABASE_URL)", createPostgresTestDb);
