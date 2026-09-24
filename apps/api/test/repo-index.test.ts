import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { repoIndexJobHandlers } from "../src/jobs/repo-index.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { REPO_INDEX_QUEUE } from "../src/services/repo-index.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.17 (spec §5.7 "codebase index (symbols + embeddings in pgvector) behind @codebase;
 * semantic search across code, chat, docs; generated repo docs and an AGENTS.md draft").
 *
 * The acceptance is the third test: an `@codebase` question cites the right file. It is proved from
 * the model's side — the fake agent answers with the paths it was handed — because that is the only
 * place the context has to arrive. The transcript is checked in the same test for the other half of
 * the design (ADR-0110): what the person sees themselves having said is what they typed.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let embedder: ReturnType<typeof Bun.serve> | null = null;
let embedderUrl = "";
let embedCalls = 0;
let ws = "";
let project = "";
let cookie = "";
const fixture = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

const RETRY = `/**
 * How many times a failed delivery is tried again, and how long between tries.
 */
export const RETRY_BUDGET = 5;

export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 100, 30_000);
}
`;

const PRESENCE = `export type Presence = { userId: string; lastSeen: number };

export function isOnline(one: Presence, now: number): boolean {
  return now - one.lastSeen < 45_000;
}
`;

const README = `# Nest

A small service that delivers things and remembers who is around.
`;

const MANIFEST = JSON.stringify(
  { name: "nest", scripts: { test: "bun test", build: "bun run build" } },
  null,
  2,
);

/**
 * A stand-in embedding provider, OpenAI-shaped. The vector is a bag of words over a fixed
 * alphabet — deterministic, and near for two texts that share words, which is all the vector half
 * has to be for a test to tell it apart from the tsvector half.
 */
function vectorOf(text: string, dimensions: number): number[] {
  const out = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().match(/[a-z_]{2,}/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % dimensions;
    out[hash] = (out[hash] ?? 0) + 1;
  }
  return out;
}

beforeAll(async () => {
  embedder = Bun.serve({
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/embeddings")) return new Response("no", { status: 404 });
      const body = (await request.json()) as { input?: string[]; dimensions?: number };
      embedCalls += 1;
      const dimensions = body.dimensions ?? 1024;
      return Response.json({
        data: (body.input ?? []).map((one, index) => ({
          index,
          embedding: vectorOf(one, dimensions),
        })),
      });
    },
  });
  embedderUrl = `http://127.0.0.1:${embedder.port}`;

  booted = await bootTestApp({}, { sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-index-"));
  booted.runners.attach(
    createInProcessRunner({
      projectsDir,
      portsIntervalMs: 0,
      sessions: {
        agents: { fake: { name: "Fake Agent", command: process.execPath, args: [fixture] } },
        defaultAgent: "fake",
      },
    }),
  );
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  embedder?.stop(true);
  rmSync(projectsDir, { recursive: true, force: true });
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function write(path: string, content: string): Promise<void> {
  const res = await call(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
    method: "PUT",
    json: { path, content },
  });
  expect(res.status).toBe(200);
}

type Hit = { path: string; symbol: string | null; start_line: number; content: string };
type Indexed = {
  chunks: number;
  files: number;
  embedded: number;
  embedding_skipped: string | null;
};
type SessionBody = { id: string; status: string };
type EventsBody = {
  events: { seq: number; event: { type: string; delta?: string; text?: string } }[];
};

describe("repo intelligence (task 2.17)", () => {
  test("a project with four files, indexed in one pass", async () => {
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Ida",
        email: `ida-index-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signed.status).toBe(200);
    cookie = cookiesFrom(signed);
    const made = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Index Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const created = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "Nest" },
    })) as { body: { id: string } };
    project = created.body.id;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
        body: { status: string };
      };
      if (res.body.status === "ready") break;
      if (Date.now() > deadline) throw new Error(`project stayed ${res.body.status}`);
      await Bun.sleep(50);
    }

    // Nothing indexed yet: the status says so, and a question says so rather than "nothing found".
    const before = (await call(`/api/workspaces/${ws}/projects/${project}/index`)) as {
      status: number;
      body: { chunks: number; commit_sha: string | null; embedding_model: string | null };
    };
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ chunks: 0, commit_sha: null, embedding_model: null });
    const early = await call(`/api/workspaces/${ws}/projects/${project}/codebase?q=retry`);
    expect(early.status).toBe(409);

    await write("src/retry.ts", RETRY);
    await write("src/presence.ts", PRESENCE);
    await write("README.md", README);
    await write("package.json", MANIFEST);
    // Not indexable: a lock file is noise, and node_modules is somebody else's code.
    await write("bun.lock", "lockfileVersion = 1\n");
    await write("node_modules/left-pad/index.js", "module.exports = () => {};\n");

    const indexed = (await call(`/api/workspaces/${ws}/projects/${project}/index`, {
      method: "POST",
      json: { wait: true },
    })) as { status: number; body: Indexed };
    expect(indexed.status).toBe(202);
    expect(indexed.body.files).toBe(4);
    expect(indexed.body.chunks).toBeGreaterThanOrEqual(4);
    // No embedding brain yet, so the words are all there is — and the index still exists.
    expect(indexed.body.embedded).toBe(0);
    expect(indexed.body.embedding_skipped).toContain("embedding model");

    const after = (await call(`/api/workspaces/${ws}/projects/${project}/index`)) as {
      body: { chunks: number; files: number; commit_sha: string | null; indexed_at: string | null };
    };
    expect(after.body.files).toBe(4);
    expect(after.body.commit_sha).toBe("working");
    expect(after.body.indexed_at).not.toBeNull();
  }, 60_000);

  test("the words find the file, and so does the meaning once a brain embeds it", async () => {
    const words = (await call(
      `/api/workspaces/${ws}/projects/${project}/codebase?q=retry budget`,
    )) as { status: number; body: { hits: Hit[] } };
    expect(words.status).toBe(200);
    expect(words.body.hits[0]?.path).toBe("src/retry.ts");
    expect(words.body.hits[0]?.content).toContain("RETRY_BUDGET");

    // A question whose words are nowhere in the file: the tsvector half has nothing to say.
    const missed = (await call(
      `/api/workspaces/${ws}/projects/${project}/codebase?q=who is around`,
    )) as { body: { hits: Hit[] } };
    expect(missed.body.hits.map((one) => one.path)).not.toContain("src/presence.ts");

    // Now a brain to embed with. The credential holds no key: an endpoint, the way Ollama arrives.
    const credential = (await call(`/api/workspaces/${ws}/credentials`, {
      method: "POST",
      json: {
        provider: "ollama",
        kind: "endpoint",
        scope: "workspace",
        label: "Stand-in embedder",
        base_url: `${embedderUrl}/v1`,
      },
    })) as { status: number; body: { id: string } };
    expect(credential.status).toBe(201);
    const profile = (await call(`/api/workspaces/${ws}/model-profiles`, {
      method: "POST",
      json: {
        name: "Nest Embedder",
        provider: "ollama",
        model_id: "embed-test",
        credential_id: credential.body.id,
        default_for: "embedding",
      },
    })) as { status: number; body: { default_for: string | null } };
    expect(profile.status).toBe(201);
    expect(profile.body.default_for).toBe("embedding");

    embedCalls = 0;
    const again = (await call(`/api/workspaces/${ws}/projects/${project}/index`, {
      method: "POST",
      json: { wait: true },
    })) as { body: Indexed };
    expect(embedCalls).toBeGreaterThan(0);
    expect(again.body.embedded).toBe(again.body.chunks);
    expect(again.body.embedding_skipped).toBeNull();

    const status = (await call(`/api/workspaces/${ws}/projects/${project}/index`)) as {
      body: { embedded: number; embedding_model: string | null };
    };
    expect(status.body.embedded).toBeGreaterThan(0);
    expect(status.body.embedding_model).toBe("Nest Embedder");

    // The same question the words missed, answered by the vectors.
    const meaning = (await call(
      `/api/workspaces/${ws}/projects/${project}/codebase?q=who is around`,
    )) as { body: { hits: Hit[] } };
    expect(meaning.body.hits.map((one) => one.path)).toContain("src/presence.ts");
  }, 60_000);

  test("a reindex asked for without waiting runs on the queue", async () => {
    await write("src/webhooks.ts", "export const WEBHOOK_TIMEOUT_MS = 10_000;\n");
    const queued = (await call(`/api/workspaces/${ws}/projects/${project}/index`, {
      method: "POST",
      json: {},
    })) as { status: number; body: { queued: boolean; chunks: number | null } };
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ queued: true, chunks: null });

    // The worker's side of the same request: the handlers the api and the CLI both register.
    const worker = booted.queue.worker({
      queues: [REPO_INDEX_QUEUE],
      handlers: repoIndexJobHandlers(booted),
    });
    const ran = await worker.tick();
    expect(ran?.queue).toBe(REPO_INDEX_QUEUE);
    await worker.stop();

    const found = (await call(
      `/api/workspaces/${ws}/projects/${project}/codebase?q=WEBHOOK_TIMEOUT_MS`,
    )) as { body: { hits: Hit[] } };
    expect(found.body.hits[0]?.path).toBe("src/webhooks.ts");
  }, 60_000);

  test("a reindex forgets a file that was deleted since the last one", async () => {
    // The commit an index is keyed by does not move between passes (it is the setup-time head,
    // or "working"), so the pass itself has to replace what the project had.
    const [onDisk] = readdirSync(projectsDir, { recursive: true, encoding: "utf8" })
      .filter((one) => one.replaceAll("\\", "/").endsWith("src/webhooks.ts"))
      .map((one) => join(projectsDir, one));
    if (!onDisk) throw new Error("src/webhooks.ts is not in the project directory");
    rmSync(onDisk);
    const before = (await call(`/api/workspaces/${ws}/projects/${project}/index`)) as {
      body: { files: number };
    };
    const reindexed = (await call(`/api/workspaces/${ws}/projects/${project}/index`, {
      method: "POST",
      json: { wait: true },
    })) as { status: number; body: Indexed };
    expect(reindexed.status).toBe(202);
    const after = (await call(`/api/workspaces/${ws}/projects/${project}/index`)) as {
      body: { files: number; chunks: number };
    };
    expect(after.body.files).toBe(before.body.files - 1);
    expect(after.body.chunks).toBe(reindexed.body.chunks);
    const gone = (await call(
      `/api/workspaces/${ws}/projects/${project}/codebase?q=WEBHOOK_TIMEOUT_MS`,
    )) as { body: { hits: Hit[] } };
    expect(gone.body.hits.map((one) => one.path)).not.toContain("src/webhooks.ts");
  }, 60_000);

  test("an @codebase question cites the right file, and the transcript keeps the person's words", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Asks the codebase" },
    })) as { status: number; body: SessionBody };
    expect(created.status).toBe(201);
    const id = created.body.id;

    const asked = "@codebase where is the retry budget?";
    const sent = await call(`/api/sessions/${id}/turns`, { method: "POST", json: { text: asked } });
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/sessions/${id}`)) as { body: SessionBody };
      if (res.body.status === "idle" || res.body.status === "error") break;
      if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}`);
      await Bun.sleep(50);
    }

    const replay = (await call(`/api/sessions/${id}/events`)) as { body: EventsBody };
    const said = replay.body.events
      .filter((one) => one.event.type === "text")
      .map((one) => one.event.delta ?? "")
      .join("");
    // The acceptance: the model was handed the file the question is about.
    expect(said).toContain("cited: src/retry.ts");
    // And the question itself survived the context in front of it.
    expect(said).toContain(`asked: ${asked}`);

    // The other half (ADR-0110): the turn in the transcript is what the person typed, not the
    // context Perch put in front of it.
    const turn = replay.body.events.find((one) => one.event.type === "turn");
    expect(turn?.event.text).toBe(asked);
    expect(turn?.event.text).not.toContain("From this project's index");
  }, 60_000);

  test("the first turn of a session gets the same context", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Asks on the way in", prompt: "@codebase the retry budget?" },
    })) as { status: number; body: SessionBody };
    expect(created.status).toBe(201);
    const id = created.body.id;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/sessions/${id}`)) as { body: SessionBody };
      if (res.body.status === "idle" || res.body.status === "error") break;
      if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}`);
      await Bun.sleep(50);
    }
    const replay = (await call(`/api/sessions/${id}/events`)) as { body: EventsBody };
    const said = replay.body.events
      .filter((one) => one.event.type === "text")
      .map((one) => one.event.delta ?? "")
      .join("");
    expect(said).toContain("cited: src/retry.ts");
  }, 60_000);

  test("a turn with no @codebase is never searched for, and an AGENTS.md is drafted", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: { engine: "acp", title: "Asks plainly" },
    })) as { body: SessionBody };
    const id = created.body.id;
    const sent = await call(`/api/sessions/${id}/turns`, {
      method: "POST",
      json: { text: "where is the retry budget?" },
    });
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = (await call(`/api/sessions/${id}`)) as { body: SessionBody };
      if (res.body.status === "idle" || res.body.status === "error") break;
      if (Date.now() > deadline) throw new Error(`session stayed ${res.body.status}`);
      await Bun.sleep(50);
    }
    const replay = (await call(`/api/sessions/${id}/events`)) as { text: string };
    expect(replay.text).not.toContain("cited:");
    expect(replay.text).not.toContain("From this project's index");

    // The draft: what the repository shows, and prompts for what it cannot.
    const draft = (await call(`/api/workspaces/${ws}/projects/${project}/agents-draft`, {
      method: "POST",
      json: { save: true },
    })) as { status: number; body: { markdown: string; saved_to: string | null } };
    expect(draft.status).toBe(200);
    expect(draft.body.saved_to).toBe("AGENTS.md");
    expect(draft.body.markdown).toContain("# Nest — agent operating manual");
    expect(draft.body.markdown).toContain("A small service that delivers things");
    expect(draft.body.markdown).toContain("| `test` | `bun test` |");
    expect(draft.body.markdown).toContain("- `src/` — TODO");
    expect(draft.body.markdown).toContain("## Definition of done");

    const read = (await call(
      `/api/workspaces/${ws}/projects/${project}/fs/read?path=AGENTS.md`,
    )) as { status: number; body: { content: string } };
    expect(read.status).toBe(200);
    expect(read.body.content).toBe(draft.body.markdown);
  }, 60_000);

  test("a stranger cannot see another workspace's index at all", async () => {
    const mine = cookie;
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Mal",
        email: `mal-index-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    cookie = cookiesFrom(signed);
    // A workspace a caller is not in is not there at all, rather than there and refused.
    const denied = await call(`/api/workspaces/${ws}/projects/${project}/codebase?q=retry`);
    expect(denied.status).toBe(404);
    const refused = await call(`/api/workspaces/${ws}/projects/${project}/index`, {
      method: "POST",
      json: { wait: true },
    });
    expect(refused.status).toBe(404);
    cookie = mine;
  }, 60_000);
});
