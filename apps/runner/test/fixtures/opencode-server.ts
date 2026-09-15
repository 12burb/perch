/**
 * A stand-in for `opencode serve` (task 1.10): the handful of endpoints the adapter uses, with the
 * SSE stream OpenCode's SDK reads, behaving by the prompt's first word (edit, ask, slow, fail,
 * mode?, extra, or a plain reply). Files are written for real under the request's directory, so a
 * test can see the edit and the session diff the same way the adapter does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};
type Session = {
  id: string;
  directory: string;
  diffs: FileDiff[];
  aborted: boolean;
  pending: { id: string; resolve: (response: string) => void } | null;
};

export type FakeOpenCode = {
  url: string;
  prompts: { sessionID: string; agent?: string; model?: unknown; text: string }[];
  replies: { sessionID: string; permissionID: string; response: string }[];
  close(): void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function startFakeOpenCode(): FakeOpenCode {
  const sessions = new Map<string, Session>();
  const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const prompts: FakeOpenCode["prompts"] = [];
  const replies: FakeOpenCode["replies"] = [];
  let counter = 0;

  const emit = (event: Record<string, unknown>) => {
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const controller of listeners) {
      try {
        controller.enqueue(chunk);
      } catch {
        listeners.delete(controller);
      }
    }
  };

  const part = (
    session: Session,
    messageID: string,
    extra: Record<string, unknown>,
    delta?: string,
  ) =>
    emit({
      type: "message.part.updated",
      properties: {
        part: { id: `prt_${++counter}`, sessionID: session.id, messageID, ...extra },
        ...(delta === undefined ? {} : { delta }),
      },
    });

  async function runPrompt(
    session: Session,
    text: string,
    agent: string | undefined,
  ): Promise<Record<string, unknown>> {
    const messageID = `msg_${++counter}`;
    const [word] = text.split(/\s+/);
    const tokens = { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } };
    const info: Record<string, unknown> = {
      id: messageID,
      sessionID: session.id,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_user",
      modelID: "fake-model",
      providerID: "fake",
      mode: agent ?? "build",
      path: { cwd: session.directory, root: session.directory },
      cost: 0.01,
      tokens,
    };
    const say = (delta: string) => part(session, messageID, { type: "text", text: delta }, delta);
    const edit = async (allowed: boolean) => {
      const file = join(session.directory, "notes.txt");
      part(session, messageID, {
        type: "tool",
        callID: "call_edit",
        tool: "edit",
        state: { status: "pending", input: { filePath: file }, raw: "" },
      });
      await sleep(5);
      if (!allowed) {
        part(session, messageID, {
          type: "tool",
          callID: "call_edit",
          tool: "edit",
          state: {
            status: "error",
            input: { filePath: file },
            error: "permission denied",
            time: { start: 1, end: 2 },
          },
        });
        await say(" skipped.");
        return;
      }
      const after = "written by opencode\n";
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, after);
      const diff: FileDiff = { file, before: "", after, additions: 1, deletions: 0 };
      session.diffs.push(diff);
      part(session, messageID, {
        type: "tool",
        callID: "call_edit",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: file },
          output: "Edited notes.txt",
          title: "notes.txt",
          metadata: {
            diff: "--- /dev/null\n+++ b/notes.txt\n@@ -1,0 +1,1 @@\n+written by opencode\n",
            filediff: diff,
          },
          time: { start: 1, end: 2 },
        },
      });
      await say(" done.");
    };
    // Perch's two picker-less prompts (tasks 1.14 and 1.20): a project whose default engine is
    // OpenCode runs ⌘K and the commit message here, so the stand-in answers them the way the ACP
    // fixture does — one message, no fences, nothing else.
    if (text.startsWith("Perch commit message")) {
      const touched = /^\+\+\+ b\/(.+)$/m.exec(text)?.[1] ?? "the project";
      const scope =
        touched
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? "project";
      await say(`feat(${scope}): update ${touched}\n\nWritten by fake OpenCode from the diff.`);
      part(session, messageID, { type: "step-finish", reason: "stop", cost: 0.01, tokens });
      emit({ type: "session.idle", properties: { sessionID: session.id } });
      return { info, parts: [] };
    }
    if (text.startsWith("Perch inline edit")) {
      const fenced = /```[^\n]*\n([\s\S]*?)\n?```/.exec(text);
      const selection = fenced?.[1] ?? "";
      const rewritten = /uppercase/i.test(text)
        ? selection.toUpperCase()
        : selection
            .split("\n")
            .map((line) => (line ? `// ${line}` : line))
            .join("\n");
      await say(`Here you go:\n\`\`\`\n${rewritten}\n\`\`\`\n`);
      part(session, messageID, { type: "step-finish", reason: "stop", cost: 0.01, tokens });
      emit({ type: "session.idle", properties: { sessionID: session.id } });
      return { info, parts: [] };
    }
    switch (word) {
      case "edit":
        await say("Editing");
        await edit(true);
        break;
      case "ask": {
        await say("Asking");
        const answer = await new Promise<string>((resolve) => {
          session.pending = { id: "perm-1", resolve };
          emit({
            type: "permission.updated",
            properties: {
              id: "perm-1",
              type: "edit",
              sessionID: session.id,
              messageID,
              title: "Edit notes.txt",
              metadata: { filePath: join(session.directory, "notes.txt") },
              time: { created: Date.now() },
            },
          });
        });
        await edit(answer !== "reject");
        break;
      }
      case "slow":
        for (let i = 0; i < 100 && !session.aborted; i++) {
          await say(`tick ${i} `);
          await sleep(40);
        }
        if (session.aborted)
          info.error = { name: "MessageAbortedError", data: { message: "aborted" } };
        break;
      case "fail":
        emit({
          type: "session.error",
          properties: {
            sessionID: session.id,
            error: { name: "ProviderAuthError", data: { providerID: "openai", message: "no key" } },
          },
        });
        info.error = {
          name: "ProviderAuthError",
          data: { providerID: "openai", message: "no key" },
        };
        break;
      case "mode?":
        await say(agent ?? "build");
        break;
      case "extra": {
        const file = join(session.directory, "extra.txt");
        writeFileSync(file, "made on the side\n");
        session.diffs.push({
          file,
          before: "",
          after: "made on the side\n",
          additions: 1,
          deletions: 0,
        });
        await say("Changed something on the side.");
        break;
      }
      default:
        await say("Hello from");
        await say(" fake OpenCode");
    }
    part(session, messageID, {
      type: "step-finish",
      reason: "stop",
      cost: 0.01,
      tokens,
    });
    emit({ type: "session.idle", properties: { sessionID: session.id } });
    return { info, parts: [] };
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      // The SDK sends the directory URL-encoded in the x-opencode-directory header (or the query).
      const rawDirectory =
        url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory");
      const directory = rawDirectory ? decodeURIComponent(rawDirectory) : process.cwd();
      const segments = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/event") {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            listeners.add(c);
            c.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
              ),
            );
          },
          cancel() {
            listeners.delete(controller);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const body = (await request.json().catch(() => ({}))) as { title?: string };
        const id = `oc_${++counter}`;
        sessions.set(id, { id, directory, diffs: [], aborted: false, pending: null });
        return Response.json({
          id,
          projectID: "proj",
          directory,
          title: body.title ?? "",
          version: "1.18.30",
          time: { created: Date.now(), updated: Date.now() },
        });
      }
      if (segments[0] === "session" && segments[1]) {
        const session = sessions.get(segments[1]);
        if (!session) return Response.json({ name: "NotFoundError", data: {} }, { status: 404 });
        if (request.method === "POST" && segments[2] === "message") {
          const body = (await request.json()) as {
            parts: { type: string; text?: string }[];
            agent?: string;
            model?: unknown;
          };
          const text = body.parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
          prompts.push({ sessionID: session.id, agent: body.agent, model: body.model, text });
          session.aborted = false;
          return Response.json(await runPrompt(session, text, body.agent));
        }
        if (request.method === "POST" && segments[2] === "permissions" && segments[3]) {
          const body = (await request.json()) as { response: string };
          replies.push({
            sessionID: session.id,
            permissionID: segments[3],
            response: body.response,
          });
          if (session.pending?.id === segments[3]) {
            session.pending.resolve(body.response);
            session.pending = null;
            return Response.json(true);
          }
          return Response.json({ name: "NotFoundError", data: {} }, { status: 404 });
        }
        if (request.method === "POST" && segments[2] === "abort") {
          session.aborted = true;
          return Response.json(true);
        }
        if (request.method === "GET" && segments[2] === "diff") {
          return Response.json(session.diffs);
        }
        if (request.method === "DELETE" && segments.length === 2) {
          sessions.delete(session.id);
          return Response.json(true);
        }
      }
      return Response.json(
        { name: "NotFoundError", data: { path: url.pathname } },
        { status: 404 },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    prompts,
    replies,
    close: () => {
      for (const controller of listeners) {
        try {
          controller.close();
        } catch {
          // already gone
        }
      }
      listeners.clear();
      server.stop(true);
    },
  };
}
