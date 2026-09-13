import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { createOpencodeServer } from "@opencode-ai/sdk/server";

/**
 * Spike 0.4.3 — OpenCode SDK (spec §9.3).
 * Pass: `opencode serve` + the SDK: create session, send prompt, stream events, apply a diff, list sessions.
 *
 * Hermetic part (runs everywhere the opencode binary is present): serve, create, list, event stream, diff,
 * delete, and a prompt against a model that needs credentials which are absent (the server answers, it does
 * not hang or crash). Credentialed part: with OPENAI_API_KEY (or PERCH_SPIKE_OPENCODE_MODEL=provider/model
 * plus that provider's key in the environment) the prompt streams a real reply and the diff endpoint is read
 * after the turn. Outcome recorded in DECISIONS.md (ADR-0031). Fallback: drive OpenCode through ACP only.
 */

const binDir = join(import.meta.dir, "node_modules", ".bin");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
const hasBinary = Bun.which("opencode", { PATH: process.env.PATH }) !== null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

let project = "";
let server: Awaited<ReturnType<typeof createOpencodeServer>> | null = null;
let client: ReturnType<typeof createOpencodeClient>;

describe.skipIf(!hasBinary)("spike 0.4.3 OpenCode SDK", () => {
  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "perch-opencode-"));
    writeFileSync(join(project, "README.md"), "# spike\n");
    writeFileSync(join(project, "hello.txt"), "hello\n");
    const port = await freePort();
    server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port,
      timeout: 120_000,
      config: { autoupdate: false, share: "disabled" },
    });
    client = createOpencodeClient({ baseUrl: server.url, directory: project });
  }, 150_000);

  afterAll(() => {
    server?.close();
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("serve starts and answers the SDK: create session, list sessions, diff, delete", async () => {
    const created = await client.session.create({ body: { title: "perch spike" } });
    expect(created.error).toBeUndefined();
    const id = created.data?.id ?? "";
    expect(id.length).toBeGreaterThan(0);

    const list = await client.session.list();
    expect(list.data?.some((s) => s.id === id)).toBe(true);

    const diff = await client.session.diff({ path: { id } });
    expect(diff.error).toBeUndefined();
    expect(Array.isArray(diff.data)).toBe(true);

    const deleted = await client.session.delete({ path: { id } });
    expect(deleted.error).toBeUndefined();
  }, 60_000);

  test("the event stream delivers the server.connected event over SSE", async () => {
    const events = await client.event.subscribe();
    const iterator = events.stream[Symbol.asyncIterator]();
    const first = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("no event in 15 s")), 15_000),
      ),
    ]);
    expect(first.done).toBe(false);
    const event = first.value as { type: string };
    expect(event.type).toBe("server.connected");
    await iterator.return?.(undefined);
  }, 30_000);

  test("a prompt without credentials fails cleanly instead of hanging", async () => {
    const created = await client.session.create({ body: { title: "no creds" } });
    const id = created.data?.id ?? "";
    const result = await Promise.race([
      client.session.prompt({
        path: { id },
        body: {
          model: { providerID: "perch-missing-provider", modelID: "nope" },
          parts: [{ type: "text", text: "Say pong." }],
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("prompt hung")), 60_000)),
    ]);
    // Either a structured error or an assistant message carrying an error part; never a hang.
    expect(result.error !== undefined || result.data !== undefined).toBe(true);
    await client.session.delete({ path: { id } });
  }, 90_000);

  const modelSpec =
    process.env.PERCH_SPIKE_OPENCODE_MODEL ??
    (process.env.OPENAI_API_KEY ? "openai/gpt-4.1-mini" : "");

  test.skipIf(!modelSpec)(
    "with credentials: a prompt streams a reply and the diff is readable",
    async () => {
      const [providerID = "", modelID = ""] = modelSpec.split("/");
      const created = await client.session.create({ body: { title: "creds" } });
      const id = created.data?.id ?? "";
      const events = await client.event.subscribe();
      const seen: string[] = [];
      const collector = (async () => {
        for await (const event of events.stream) {
          const e = event as { type: string };
          seen.push(e.type);
          if (e.type === "session.idle") break;
        }
      })();
      const reply = await client.session.prompt({
        path: { id },
        body: {
          model: { providerID, modelID },
          parts: [{ type: "text", text: "Reply with the word pong." }],
        },
      });
      expect(reply.error).toBeUndefined();
      const text = JSON.stringify(reply.data);
      expect(text.toLowerCase()).toContain("pong");
      await Promise.race([collector, new Promise((r) => setTimeout(r, 10_000))]);
      expect(seen.some((t) => t.startsWith("message.part"))).toBe(true);
      const diff = await client.session.diff({ path: { id } });
      expect(Array.isArray(diff.data)).toBe(true);
      await client.session.delete({ path: { id } });
    },
    180_000,
  );
});

describe.skipIf(hasBinary)("spike 0.4.3 OpenCode SDK (binary missing)", () => {
  test("skipped: the opencode binary is not installed here", () => {
    expect(hasBinary).toBe(false);
  });
});
