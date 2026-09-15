/**
 * The inspector's half of the Preview tab (spec §5.6; task 2.16).
 *
 * The page carries the injected client; this is the pane that talks to it. Everything it knows
 * arrives by `postMessage` from the iframe, and nothing is believed unless it came from that
 * iframe's own window — the pane and a wildcard-mode preview are different origins on purpose, so
 * "same origin" is not the check; "this frame" is.
 *
 * What a selection is for is the chip: §5.6's "select → describe", where the element becomes
 * context for the next turn and the agent edits the file the dev plugin named.
 */
import "@perch/ui/i18n/code";
import { Badge, Button, t } from "@perch/ui";
import { useMutation } from "@tanstack/react-query";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { type ContextChip, useContextChips } from "./context-store.ts";

const CLIENT = "perch-inspector";
const HOST = "perch-inspector-host";

export type ElementNode = {
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
  source: string | null;
  attributes: { name: string; value: string }[];
  box: { width: number; height: number; top: number; left: number };
  chain: string[];
};

type ConsoleLine = { level: "log" | "warn" | "error"; text: string; at: number };
type FailedRequest = { url: string; status: number; method: string; at: number };

/** How an element is described to an agent: the file when there is one, the DOM when there is not. */
export function describeElement(selection: Selection): string {
  const what = [
    selection.tag,
    selection.id ? `#${selection.id}` : "",
    selection.classes.length > 0 ? `.${selection.classes.slice(0, 4).join(".")}` : "",
  ].join("");
  const where = selection.source
    ? ` at ${selection.source}`
    : ` under ${selection.chain.join(" > ")}`;
  const text = selection.text ? ` reading “${selection.text.slice(0, 60)}”` : "";
  return `the ${what}${where}${text}`;
}

/** The label on the chip: short, and the file when the dev plugin gave one. */
export function labelElement(selection: Selection): string {
  if (selection.source) {
    const file = selection.source.split("/").pop() ?? selection.source;
    return `${selection.tag} · ${file}`;
  }
  return selection.id ? `${selection.tag}#${selection.id}` : selection.tag;
}

export type InspectorState = {
  on: boolean;
  ready: boolean;
  tree: ElementNode | null;
  selection: Selection | null;
  lines: ConsoleLine[];
  failures: FailedRequest[];
  toggle: () => void;
  reveal: (path: number[]) => void;
  clearStrip: () => void;
};

/**
 * Everything the pane learns from the page. The frame is a ref because it is remounted whenever the
 * address changes, and a listener that closed over one iframe would go quiet after the first reload.
 */
export function useInspector(
  frame: RefObject<HTMLIFrameElement | null>,
  /** Changes when the iframe is remounted, so the pane forgets a page it is no longer showing. */
  key: unknown,
): InspectorState {
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  const [tree, setTree] = useState<ElementNode | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [failures, setFailures] = useState<FailedRequest[]>([]);
  const [nonce, setNonce] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the signal, not a value read
  useEffect(() => {
    setReady(false);
    setTree(null);
    setSelection(null);
    setLines([]);
    setFailures([]);
    setNonce("");
  }, [key]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // The one check that means anything here: it came from the frame this pane is showing.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as {
        source?: string;
        nonce?: string;
        type?: string;
        tree?: ElementNode;
        selection?: Selection;
        line?: ConsoleLine;
        request?: FailedRequest;
      };
      if (!data || data.source !== CLIENT || typeof data.nonce !== "string") return;
      if (data.type === "ready") {
        setNonce(data.nonce);
        setReady(true);
      } else if (data.type === "tree" && data.tree) setTree(data.tree);
      else if (data.type === "select" && data.selection) setSelection(data.selection);
      else if (data.type === "console" && data.line) {
        const line = data.line;
        setLines((previous) => [...previous, line].slice(-100));
      } else if (data.type === "request" && data.request) {
        const request = data.request;
        setFailures((previous) => [...previous, request].slice(-50));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame]);

  const post = useCallback(
    (message: Record<string, unknown>) => {
      const target = frame.current?.contentWindow;
      const src = frame.current?.src ?? "";
      if (!target || !nonce || !src) return;
      try {
        target.postMessage({ source: HOST, nonce, ...message }, new URL(src).origin);
      } catch {
        // A frame mid-navigation has nothing to tell yet.
      }
    },
    [frame, nonce],
  );

  const toggle = useCallback(() => {
    setOn((value) => {
      post({ type: value ? "disable" : "enable" });
      if (!value) post({ type: "tree" });
      return !value;
    });
  }, [post]);

  const reveal = useCallback((path: number[]) => post({ type: "reveal", path }), [post]);
  const clearStrip = useCallback(() => {
    setLines([]);
    setFailures([]);
  }, []);

  return { on, ready, tree, selection, lines, failures, toggle, reveal, clearStrip };
}

/** The Elements tree, the selected element, and the strip — the panel §5.6 describes. */
export function InspectorPanel(props: { projectId: string; state: InspectorState }) {
  const add = useContextChips((store) => store.add);
  const { state } = props;
  const chip = (chip: Omit<ContextChip, "id">) => add(props.projectId, chip);

  return (
    <section
      aria-label={t("inspect.title")}
      data-testid="inspector-panel"
      className="flex max-h-72 min-h-0 flex-col gap-2 overflow-auto rounded-md border border-border p-2 text-sm"
    >
      {state.selection ? (
        <div data-testid="inspector-selection" className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{state.selection.tag}</Badge>
            {state.selection.source ? (
              <code className="break-all text-xs">{state.selection.source}</code>
            ) : (
              <span className="text-fg-muted">{t("inspect.noSource")}</span>
            )}
            <span className="text-fg-muted">
              {state.selection.box.width}×{state.selection.box.height}
            </span>
            <Button
              size="sm"
              className="ml-auto"
              onClick={() =>
                state.selection &&
                chip({
                  kind: "element",
                  label: labelElement(state.selection),
                  text: describeElement(state.selection),
                })
              }
            >
              {t("inspect.use")}
            </Button>
          </div>
          {state.selection.text ? (
            <p className="truncate text-fg-muted">{state.selection.text}</p>
          ) : null}
          <ul className="flex flex-wrap gap-1">
            {state.selection.attributes.slice(0, 8).map((one) => (
              <li key={one.name} className="rounded bg-raised px-1 font-mono text-xs">
                {one.name}={one.value.slice(0, 40)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-fg-muted">{t("inspect.pickHint")}</p>
      )}

      {state.tree ? (
        <div>
          {/* A label, not a heading: the Preview region has no h2 for an h3 to follow. */}
          <p className="mb-1 font-medium">{t("inspect.elements")}</p>
          <ul aria-label={t("inspect.elements")} className="flex flex-col">
            <Node node={state.tree} depth={0} onReveal={state.reveal} />
          </ul>
        </div>
      ) : null}

      {state.lines.length > 0 || state.failures.length > 0 ? (
        <div data-testid="inspector-strip" className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <p className="font-medium">{t("inspect.strip")}</p>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={state.clearStrip}>
              {t("inspect.clear")}
            </Button>
          </div>
          <ul className="flex flex-col gap-1">
            {state.lines.slice(-10).map((line) => (
              <li key={`${line.at}-${line.text}`} className="flex items-start gap-2">
                <Badge tone={line.level === "error" ? "danger" : "neutral"}>{line.level}</Badge>
                <span className="min-w-0 flex-1 break-all font-mono text-xs">{line.text}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    chip({
                      kind: "console",
                      label: `${line.level}: ${line.text.slice(0, 24)}`,
                      text: `the console said ${line.level}: ${line.text.slice(0, 500)}`,
                    })
                  }
                >
                  {t("inspect.send")}
                </Button>
              </li>
            ))}
            {state.failures.slice(-10).map((request) => (
              <li key={`${request.at}-${request.url}`} className="flex items-start gap-2">
                <Badge tone="danger">{request.status || "failed"}</Badge>
                <span className="min-w-0 flex-1 break-all font-mono text-xs">{request.url}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    chip({
                      kind: "request",
                      label: `${request.status || "failed"} ${request.url.split("/").pop() ?? ""}`,
                      text: `${request.method} ${request.url} answered ${request.status || "nothing"}`,
                    })
                  }
                >
                  {t("inspect.send")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Node(props: { node: ElementNode; depth: number; onReveal: (path: number[]) => void }) {
  const { node } = props;
  const label = `${node.tag}${node.id ? `#${node.id}` : ""}${
    node.classes.length > 0 ? `.${node.classes[0]}` : ""
  }`;
  return (
    <>
      <li>
        <button
          type="button"
          className="w-full truncate text-left font-mono text-xs hover:bg-raised"
          style={{ paddingLeft: `${props.depth * 10}px` }}
          onMouseEnter={() => props.onReveal(node.path)}
          onFocus={() => props.onReveal(node.path)}
        >
          {label}
          {node.text ? <span className="text-fg-muted"> {node.text.slice(0, 30)}</span> : null}
        </button>
      </li>
      {node.children.slice(0, 40).map((child) => (
        <Node
          key={child.path.join("-")}
          node={child}
          depth={props.depth + 1}
          onReveal={props.onReveal}
        />
      ))}
    </>
  );
}

/**
 * A picture of the page, taken by the runner's own browser (spec §5.6). It goes two places: onto
 * the next turn as a chip, or into a channel as a message — which is the difference between "look
 * at this" and "everyone should see this".
 */
export function ScreenshotButton(props: {
  workspaceId: string;
  projectId: string;
  port: number;
  path: string;
  channels: { id: string; name: string | null }[];
  onChip: (chip: Omit<ContextChip, "id">) => void;
}) {
  const [channelId, setChannelId] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const named = props.channels.filter((one) => one.name);

  const take = useMutation({
    mutationFn: async (channel: string | null) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/screenshot", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: {
            port: props.port,
            path: props.path,
            ...(channel ? { channel_id: channel } : {}),
          },
        }),
      ),
    onSuccess: (shot, channel) => {
      setError(null);
      if (channel) {
        const name = named.find((one) => one.id === channel)?.name ?? "";
        setNote(t("inspect.screenshotPosted", { channel: name }));
        return;
      }
      setNote(t("inspect.screenshotDone"));
      props.onChip({
        kind: "screenshot",
        label: t("inspect.screenshot"),
        text: `${t("inspect.screenshotOf", { path: props.path })} (${shot.url})`,
      });
    },
    onError: (err) => {
      setNote(null);
      setError(err instanceof RequestFailed ? err.message : t("common.error"));
    },
  });

  return (
    <span className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={take.isPending || props.port === 0}
        onClick={() => take.mutate(null)}
      >
        {take.isPending ? t("inspect.screenshotting") : t("inspect.screenshot")}
      </Button>
      {named.length > 0 ? (
        <select
          aria-label={t("inspect.screenshotPost")}
          className="h-8 rounded-md border border-border bg-bg px-1 text-sm"
          value={channelId}
          onChange={(event) => {
            setChannelId(event.target.value);
            if (event.target.value) take.mutate(event.target.value);
          }}
        >
          <option value="">{t("inspect.screenshotPost")}</option>
          {named.map((one) => (
            <option key={one.id} value={one.id}>
              #{one.name}
            </option>
          ))}
        </select>
      ) : null}
      {note ? (
        <span role="status" className="text-sm text-success">
          {note}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
