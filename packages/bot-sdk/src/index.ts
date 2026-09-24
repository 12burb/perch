/**
 * @perch/bot-sdk — the client an external bot is written against (spec §5.3, §7.3; task 2.19).
 *
 * Two halves, and nothing else. `bot.chat.postMessage(…)` is the Bot API over HTTP, Slack-shaped so
 * that anybody who has written a Slack app already knows it. `bot.on("app_mention", …)` is socket
 * mode: the bot connects with its own token and is told what happens where it is installed.
 *
 * No dependencies: `fetch` and `WebSocket` are both platform globals in Bun, Node 22, Deno and a
 * browser. A bot should be a file you can run, not a tree you have to install.
 */

export const packageName = "@perch/bot-sdk";

/** What a bot token may do (spec §7.3). */
export type BotScope =
  | "chat:write"
  | "chat:read"
  | "channels:read"
  | "files:write"
  | "tools:call"
  | "sessions:open"
  | "work:write";

export type PerchBotOptions = {
  /** Where Perch is, for example `https://perch.example.com`. */
  url: string;
  /** The bot's own token, minted in its settings; it starts `pbot_`. */
  token: string;
  /** Swapped in tests; the platform's `fetch` otherwise. */
  fetch?: typeof fetch;
  /** Swapped in tests; the platform's `WebSocket` otherwise. */
  webSocket?: typeof WebSocket;
  /**
   * Where an event handler's error goes. A handler that throws — a refused `postMessage`, a 429 —
   * is reported here and the other handlers still run; without this it is `console.error`, never
   * an unhandled rejection that ends the process.
   */
  onError?: (error: unknown, frame: BotEventFrame) => void;
  /**
   * The socket closed after Perch said hello: the api restarted, the network dropped, or
   * `disconnect()` was called (`requested`). A bot that should keep listening calls `connect()`
   * again from here, after a pause of its choosing.
   */
  onClose?: (info: BotSocketClose) => void;
};

/** How a socket ended: its close code and reason, and whether this bot asked for it. */
export type BotSocketClose = { code: number; reason: string; requested: boolean };

export type BotMessage = {
  ok: true;
  message_id: string;
  ts: string;
  channel: string;
  thread_ts: string | null;
};

export type BotFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Where the bytes are, relative to the Perch url the bot was constructed with. */
  url: string;
};

export type BotConversation = {
  id: string;
  name: string | null;
  type: string;
  topic: string | null;
};

export type BotHistoryMessage = {
  message_id: string;
  ts: string;
  thread_ts: string | null;
  author_type: "user" | "bot" | "system";
  author_id: string;
  text: string;
  blocks: { type: string }[];
};

/** A work item as `work.create` answers with it. */
export type BotWorkItem = {
  id: string;
  /** `KEY-123`. */
  identifier: string;
  project_id: string;
  title: string;
  type: string;
  state: string;
  priority: number;
  thread_ts: string | null;
};

/** Anything a bot is told (spec §7.3), plus the `hello` the socket opens with. */
export type BotEventName =
  | "hello"
  | "message.created"
  | "app_mention"
  | "reaction.added"
  | "channel.joined"
  | "interaction.received"
  | "session.completed"
  | "work_item.updated";

export type BotEventFrame<P = Record<string, unknown>> = {
  type: BotEventName | "pong";
  ts: string;
  payload: P;
};

export type BotEventHandler<P = Record<string, unknown>> = (
  payload: P,
  frame: BotEventFrame<P>,
) => void | Promise<void>;

/** A `File` knows what it is called; a bare `Blob` does not. */
function nameOf(blob: Blob): string {
  const named = blob as { name?: unknown };
  return typeof named.name === "string" && named.name ? named.name : "upload";
}

/**
 * How long to wait, from a `Retry-After` header or the error's own `retry_after`. A missing header
 * is `undefined` rather than zero: "wait no time at all" is not what a 429 means.
 */
function seconds(value: unknown): number | undefined {
  const number =
    typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** What the api answered when it would not do the thing (spec §7.8). */
/** The JSON object an answer carries, `{}` for an empty body, null for anything else. */
function parseBody(text: string): Record<string, unknown> | null {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class PerchBotError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Seconds to wait, on a 429 (spec §7.3's Retry-After). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "PerchBotError";
  }
}

export class PerchBot {
  private readonly base: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly Socket: typeof WebSocket;
  private readonly handlers = new Map<string, Set<BotEventHandler<never>>>();
  private socket: WebSocket | null = null;
  private closing = false;
  private readonly onError: (error: unknown, frame: BotEventFrame) => void;
  private readonly onClose: ((info: BotSocketClose) => void) | undefined;

  constructor(options: PerchBotOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.Socket = options.webSocket ?? globalThis.WebSocket;
    this.onError =
      options.onError ??
      ((error, frame) => console.error(`perch-bot-sdk: a ${frame.type} handler failed`, error));
    this.onClose = options.onClose;
  }

  /** Spec §7.3's `chat.*`. */
  readonly chat = {
    postMessage: (input: {
      channel: string;
      text?: string;
      blocks?: unknown[];
      thread_ts?: string;
    }): Promise<BotMessage> => this.post("chat.postMessage", input),
    update: (input: { ts: string; text?: string; blocks?: unknown[] }): Promise<BotMessage> =>
      this.post("chat.update", input),
    delete: (input: { ts: string }): Promise<{ ok: true }> => this.post("chat.delete", input),
  };

  /** Spec §7.3's `conversations.*`. */
  readonly conversations = {
    list: async (): Promise<BotConversation[]> =>
      (await this.get<{ channels: BotConversation[] }>("conversations.list", {})).channels,
    history: async (input: {
      channel: string;
      oldest?: string;
      latest?: string;
      limit?: number;
    }): Promise<BotHistoryMessage[]> =>
      (await this.get<{ messages: BotHistoryMessage[] }>("conversations.history", input)).messages,
    replies: async (input: { ts: string; limit?: number }): Promise<BotHistoryMessage[]> =>
      (await this.get<{ messages: BotHistoryMessage[] }>("conversations.replies", input)).messages,
  };

  /** Spec §7.3's `files.upload`. The bytes go up as multipart, like any other upload. */
  readonly files = {
    upload: async (input: { file: Blob; filename?: string }): Promise<BotFile> => {
      const form = new FormData();
      form.append("file", input.file, input.filename ?? nameOf(input.file));
      const res = await this.doFetch(`${this.base}/api/bot/files.upload`, {
        method: "POST",
        // No content-type: the runtime sets it with the multipart boundary.
        headers: { authorization: `Bearer ${this.token}` },
        body: form,
      });
      return (await this.read<{ file: BotFile }>(res)).file;
    },
  };

  readonly users = {
    info: (input: { user: string }) =>
      this.get<{ user: { id: string; name: string; handle: string } }>("users.info", input),
  };

  readonly tools = {
    call: (input: { connection_id: string; tool: string; args?: Record<string, unknown> }) =>
      this.post<{ result: unknown }>("tools.call", { args: {}, ...input }),
  };

  readonly sessions = {
    open: (input: { project: string; engine?: string; prompt?: string }) =>
      this.post<{ session_id: string; status: string }>("sessions.open", input),
  };

  /** Spec §7.3's `work.create`: an item on a project's board, made by this bot. */
  readonly work = {
    create: (input: {
      project: string;
      title: string;
      description?: string;
      type?: "task" | "bug" | "feature" | "epic";
      state?: string;
      priority?: number;
      thread_ts?: string;
    }) => this.post<{ item: BotWorkItem }>("work.create", input),
  };

  /** Something happened where this bot is installed. Returns the function that stops listening. */
  on<P = Record<string, unknown>>(event: BotEventName, handler: BotEventHandler<P>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as BotEventHandler<never>);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as BotEventHandler<never>);
    };
  }

  /**
   * Socket mode. Resolves once the socket is open and Perch has said hello, so a script can
   * `await bot.connect()` and know it will not miss what happens next.
   */
  connect(): Promise<void> {
    this.closing = false;
    const url = new URL(`${this.base}/api/bot/socket`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", this.token);
    const socket = new this.Socket(url.toString());
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let greeted = false;
      socket.addEventListener("message", (event: MessageEvent) => {
        const raw = typeof event.data === "string" ? event.data : "";
        let frame: BotEventFrame;
        try {
          frame = JSON.parse(raw) as BotEventFrame;
        } catch {
          return;
        }
        if (frame.type === "hello" && !greeted) {
          greeted = true;
          resolve();
        }
        void this.dispatch(frame);
      });
      socket.addEventListener("error", () => {
        if (!greeted) reject(new Error("the bot socket would not open"));
      });
      socket.addEventListener("close", (event: CloseEvent) => {
        const code = typeof event?.code === "number" ? event.code : 1006;
        const reason = typeof event?.reason === "string" ? event.reason : "";
        if (this.socket === socket) this.socket = null;
        if (!greeted) {
          // A refused token closes with 1008 and says why; that is worth more than "it closed".
          reject(
            new Error(
              `the bot socket closed before saying hello (${code}${reason ? `: ${reason}` : ""})`,
            ),
          );
          return;
        }
        this.onClose?.({ code, reason, requested: this.closing });
      });
    });
  }

  /** Stops listening. A bot that is going away should say so rather than being timed out. */
  disconnect(): void {
    this.closing = true;
    this.socket?.close(1000, "done");
    this.socket = null;
  }

  get connected(): boolean {
    return this.socket !== null && !this.closing;
  }

  /** Every handler for the frame, in order; one that throws is reported and does not stop the rest. */
  private async dispatch(frame: BotEventFrame): Promise<void> {
    for (const handler of this.handlers.get(frame.type) ?? []) {
      try {
        await (handler as BotEventHandler)(frame.payload, frame);
      } catch (error) {
        try {
          this.onError(error, frame);
        } catch {
          // An error handler that throws has nowhere left to report to.
        }
      }
    }
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  private async post<T>(method: string, body: unknown): Promise<T & { ok: true }> {
    const res = await this.doFetch(`${this.base}/api/bot/${method}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.read<T>(res);
  }

  private async get<T>(method: string, query: Record<string, unknown>): Promise<T & { ok: true }> {
    const url = new URL(`${this.base}/api/bot/${method}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const res = await this.doFetch(url.toString(), { headers: this.headers() });
    return this.read<T>(res);
  }

  private async read<T>(res: Response): Promise<T & { ok: true }> {
    const text = await res.text();
    const body = parseBody(text);
    if (body === null) {
      // Not Perch answering: a proxy's error page, a truncated body. The status is still the truth.
      throw new PerchBotError(
        res.status,
        "bad_response",
        `perch answered ${res.status} with a body that is not JSON`,
        { body: text.slice(0, 200) },
      );
    }
    if (res.ok) return body as T & { ok: true };
    const error = (body.error ?? {}) as { code?: string; message?: string; details?: unknown };
    const details = (error.details as Record<string, unknown> | undefined) ?? undefined;
    const wait = seconds(res.headers.get("retry-after")) ?? seconds(details?.retry_after);
    throw new PerchBotError(
      res.status,
      error.code ?? "internal",
      error.message ?? `perch answered ${res.status}`,
      details,
      wait,
    );
  }
}
