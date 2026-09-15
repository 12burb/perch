/**
 * The injected inspector (spec §5.6; task 2.16). It runs inside the previewed page, so it is one
 * self-contained function with no imports: `INSPECTOR_CLIENT` is that function's own source, which
 * is what the preview proxy inserts before `</head>`.
 *
 * Everything it learns goes to the Preview tab by `postMessage`, addressed to one origin and signed
 * with the nonce the proxy minted for this page — so a page that is not Perch's preview pane cannot
 * talk to the pane, and the pane ignores anything that is not this page (AGENTS.md §1.6's spirit:
 * the injected script is the only thing in the preview that Perch put there, and it says so).
 */

/** What the page sends the pane, and what the pane sends back. */
export const CLIENT_MESSAGE = "perch-inspector";
export const HOST_MESSAGE = "perch-inspector-host";

export type ElementNode = {
  /** A path of child indexes from <body>, which is how the pane asks for a node again. */
  path: number[];
  tag: string;
  id: string;
  classes: string[];
  text: string;
  children: ElementNode[];
};

export type Selection = {
  path: number[];
  tag: string;
  id: string;
  classes: string[];
  text: string;
  /** `data-perch-src`, when the dev plugin put one there. */
  source: string | null;
  attributes: { name: string; value: string }[];
  box: { width: number; height: number; top: number; left: number };
  /** The tag names from <body> down to this element: §5.6's component chain, as the DOM has it. */
  chain: string[];
};

export type ConsoleLine = { level: "log" | "warn" | "error"; text: string; at: number };
export type FailedRequest = { url: string; status: number; method: string; at: number };

export type ClientMessage =
  | { source: typeof CLIENT_MESSAGE; nonce: string; type: "ready" }
  | { source: typeof CLIENT_MESSAGE; nonce: string; type: "tree"; tree: ElementNode }
  | { source: typeof CLIENT_MESSAGE; nonce: string; type: "select"; selection: Selection }
  | { source: typeof CLIENT_MESSAGE; nonce: string; type: "console"; line: ConsoleLine }
  | { source: typeof CLIENT_MESSAGE; nonce: string; type: "request"; request: FailedRequest };

export type HostMessage =
  | { source: typeof HOST_MESSAGE; nonce: string; type: "enable" }
  | { source: typeof HOST_MESSAGE; nonce: string; type: "disable" }
  | { source: typeof HOST_MESSAGE; nonce: string; type: "tree" }
  | { source: typeof HOST_MESSAGE; nonce: string; type: "reveal"; path: number[] };

/**
 * The bits of a page this uses, as its own interfaces. The client is serialized and runs in a
 * browser, but this module is compiled by a server — so it names what it touches rather than
 * pulling a DOM lib into everything that imports it.
 */
type El = {
  tagName: string;
  id: string;
  classList: { [Symbol.iterator](): Iterator<string> };
  attributes: { [Symbol.iterator](): Iterator<{ name: string; value: string }> };
  children: { length: number; [index: number]: El | undefined; [Symbol.iterator](): Iterator<El> };
  parentElement: El | null;
  textContent: string | null;
  style: {
    cssText: string;
    display: string;
    top: string;
    left: string;
    width: string;
    height: string;
  };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { top: number; left: number; width: number; height: number };
  append(...nodes: El[]): void;
};
type Doc = {
  body: El | null;
  documentElement: { style: { cursor: string } };
  createElement(tag: string): El & { textContent: string | null };
};
type Win = {
  document: Doc;
  parent: { postMessage(message: unknown, origin: string): void };
  console: Record<"log" | "warn" | "error", (...args: unknown[]) => void>;
  fetch: (input: unknown, init?: { method?: string }) => Promise<{ ok: boolean; status: number }>;
  addEventListener(type: string, handler: (event: never) => void, capture?: boolean): void;
  Date: DateConstructor;
};

/**
 * The whole client, as one function. It takes only strings so that its source can be serialized and
 * called with the nonce and origin of the moment; it must never reference anything outside itself.
 */
function client(nonce: string, origin: string): void {
  const win = globalThis as unknown as Win;
  const CLIENT = "perch-inspector";
  const HOST = "perch-inspector-host";
  const MAX_TREE = 2000;
  const doc = win.document;
  let on = false;
  let hovered: El | null = null;
  const seen: number[] = [];

  const box = doc.createElement("div");
  box.setAttribute("data-perch-overlay", "");
  box.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #6d8cff;" +
    "background:rgba(109,140,255,.14);border-radius:2px;display:none;transition:all .05s";
  const label = doc.createElement("div");
  label.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;background:#1b1d23;color:#e8eaf0;" +
    "font:11px ui-monospace,monospace;padding:2px 6px;border-radius:3px;display:none;max-width:60vw;" +
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

  function send(message: Record<string, unknown>): void {
    try {
      win.parent.postMessage({ source: CLIENT, nonce, ...message }, origin);
    } catch {
      // A pane that has gone away is not an error in the page.
    }
  }

  function pathOf(element: El): number[] {
    const path: number[] = [];
    let node: El | null = element;
    while (node && node !== doc.body && node.parentElement) {
      path.unshift([...node.parentElement.children].indexOf(node));
      node = node.parentElement;
    }
    return path;
  }

  function at(path: number[]): El | null {
    let node: El | null = doc.body;
    for (const index of path) {
      const child: El | undefined = node?.children[index];
      if (!child) return null;
      node = child;
    }
    return node;
  }

  function text(element: El): string {
    return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function ours(element: El): boolean {
    return element.hasAttribute("data-perch-overlay");
  }

  function describe(element: El): Record<string, unknown> {
    const rect = element.getBoundingClientRect();
    const chain: string[] = [];
    let node: El | null = element;
    while (node && node !== doc.body) {
      chain.unshift(node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return {
      path: pathOf(element),
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      classes: [...element.classList],
      text: text(element),
      source: element.getAttribute("data-perch-src"),
      attributes: [...element.attributes]
        .filter((one) => one.name !== "data-perch-src")
        .slice(0, 40)
        .map((one) => ({ name: one.name, value: one.value.slice(0, 200) })),
      box: {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
      },
      chain,
    };
  }

  function outline(element: El | null): void {
    if (!element) {
      box.style.display = "none";
      label.style.display = "none";
      return;
    }
    const rect = element.getBoundingClientRect();
    box.style.display = "block";
    box.style.top = `${rect.top}px`;
    box.style.left = `${rect.left}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    const source = element.getAttribute("data-perch-src");
    label.textContent = `${element.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(
      rect.height,
    )}${source ? ` · ${source}` : ""}`;
    label.style.display = "block";
    label.style.top = `${Math.max(0, rect.top - 20)}px`;
    label.style.left = `${rect.left}px`;
  }

  function tree(root: El, depth: number): Record<string, unknown> | null {
    if (ours(root) || seen.length > MAX_TREE) return null;
    seen.push(1);
    const children: Record<string, unknown>[] = [];
    if (depth > 0) {
      for (const child of root.children) {
        const one = tree(child, depth - 1);
        if (one) children.push(one);
      }
    }
    return {
      path: pathOf(root),
      tag: root.tagName.toLowerCase(),
      id: root.id || "",
      classes: [...root.classList].slice(0, 12),
      text: root.children.length === 0 ? text(root) : "",
      children,
    };
  }

  function sendTree(): void {
    seen.length = 0;
    const body = doc.body;
    const root = body ? tree(body, 12) : null;
    if (root) send({ type: "tree", tree: root });
  }

  function onMove(event: { target: El | null }): void {
    if (!on) return;
    const element = event.target;
    if (!element || ours(element)) return;
    hovered = element;
    outline(element);
  }

  function onClick(event: {
    target: El | null;
    preventDefault(): void;
    stopPropagation(): void;
  }): void {
    if (!on) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.target ?? hovered;
    if (element && !ours(element)) send({ type: "select", selection: describe(element) });
  }

  function onKey(event: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    key: string;
    preventDefault(): void;
  }): void {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      enable(!on);
    }
  }

  function enable(next: boolean): void {
    on = next;
    doc.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) outline(null);
  }

  // The console and the failed requests §5.6 puts in the strip. Both are wrapped rather than
  // replaced: the page's own logging goes on working exactly as it did.
  for (const level of ["log", "warn", "error"] as const) {
    const original = win.console[level].bind(win.console);
    win.console[level] = (...args: unknown[]) => {
      original(...args);
      send({
        type: "console",
        line: {
          level,
          text: args
            .map((one) => {
              if (typeof one === "string") return one;
              try {
                return JSON.stringify(one);
              } catch {
                return String(one);
              }
            })
            .join(" ")
            .slice(0, 2000),
          at: Date.now(),
        },
      });
    };
  }
  win.addEventListener("error", (event: { message?: unknown }) => {
    send({
      type: "console",
      line: { level: "error", text: String(event.message ?? "").slice(0, 2000), at: Date.now() },
    });
  });
  win.addEventListener("unhandledrejection", (event: { reason?: unknown }) => {
    send({
      type: "console",
      line: { level: "error", text: String(event.reason ?? "").slice(0, 2000), at: Date.now() },
    });
  });

  const fetched = win.fetch.bind(win);
  // Wrapped, not replaced: Bun's fetch type carries extras this never uses, and the page's own
  // calls keep working either way.
  const wrapped = async (
    input: unknown,
    init?: { method?: string },
  ): Promise<{ ok: boolean; status: number }> => {
    const asRequest = input as { method?: string; url?: string } | null;
    const method = init?.method ?? asRequest?.method ?? "GET";
    const url = String(asRequest?.url ?? input);
    try {
      const response = await fetched(input, init);
      if (!response.ok) {
        send({
          type: "request",
          request: { url, status: response.status, method, at: Date.now() },
        });
      }
      return response;
    } catch (error) {
      send({ type: "request", request: { url, status: 0, method, at: Date.now() } });
      throw error;
    }
  };
  win.fetch = wrapped;

  win.addEventListener("message", (event: { origin: string; data: unknown }) => {
    if (event.origin !== origin) return;
    const data = event.data as { source?: string; nonce?: string; type?: string; path?: number[] };
    if (!data || data.source !== HOST || data.nonce !== nonce) return;
    if (data.type === "enable") enable(true);
    else if (data.type === "disable") enable(false);
    else if (data.type === "tree") sendTree();
    else if (data.type === "reveal") outline(at(data.path ?? []));
  });

  win.addEventListener("mousemove", onMove as (event: never) => void, true);
  win.addEventListener("click", onClick as (event: never) => void, true);
  win.addEventListener("keydown", onKey as (event: never) => void, true);
  win.addEventListener("scroll", () => outline(on ? hovered : null), true);

  function start(): void {
    doc.body?.append(box, label);
    send({ type: "ready" });
    sendTree();
  }
  if (doc.body) start();
  else win.addEventListener("DOMContentLoaded", start);
}

/**
 * The script the proxy inserts. `{{nonce}}` and `{{origin}}` are replaced there — the values are a
 * per-response nonce and the pane's own origin, and neither belongs in a module constant.
 */
export const INSPECTOR_CLIENT = `(${client.toString()})("{{nonce}}","{{origin}}");`;

/** The client with this page's nonce and pane origin in it. */
export function inspectorClient(nonce: string, origin: string): string {
  return INSPECTOR_CLIENT.replace("{{nonce}}", jsString(nonce)).replace(
    "{{origin}}",
    jsString(origin),
  );
}

/** Neither value is ever a quote or a backslash, but a script tag is no place to assume that. */
function jsString(value: string): string {
  return value.replace(/[^A-Za-z0-9:/._@-]/g, "");
}
