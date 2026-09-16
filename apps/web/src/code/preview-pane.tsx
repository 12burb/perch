/**
 * The Preview tab (spec §4 "main: editor tabs / session transcript / Preview", §5.6; task 1.18).
 *
 * A dev server running on the project's runner, in an iframe, through Perch's proxy. The chrome is
 * the part a browser normally gives you and an iframe does not: an address bar for the path, back
 * and forward, reload, viewport presets to see the phone layout without a phone, and a way out to
 * a real tab. Sharing mints an expiring link that opens without a Perch account.
 *
 * The inspector (⌘⇧C) is the proxy's injected client talking back to this pane (task 2.16); a share
 * link never carries it (§5.6).
 */
import "@perch/ui/i18n/code";
import { Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { channelsQuery, previewsQuery } from "../lib/queries.ts";
import { useContextChips } from "./context-store.ts";
import { InspectorPanel, ScreenshotButton, useInspector } from "./inspector.tsx";

/** The presets §5.6 asks for, in CSS pixels; "fit" fills whatever room the pane has. */
const VIEWPORTS = {
  fit: null,
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

function message(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

/** The path part of a preview URL, which is what the address bar edits. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    // Path mode carries the prefix in the URL; the person only ever edits what comes after it.
    const prefixed = /^\/p\/[^/]+\/\d+(\/.*)?$/.exec(parsed.pathname);
    return `${prefixed ? (prefixed[1] ?? "/") : parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

/** That URL with a different path, however the instance spells preview URLs. */
function withPath(url: string, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  try {
    const parsed = new URL(url);
    const prefixed = /^(\/p\/[^/]+\/\d+)(\/.*)?$/.exec(parsed.pathname);
    parsed.search = "";
    parsed.pathname = prefixed ? `${prefixed[1]}${clean}` : clean;
    const query = clean.indexOf("?");
    if (query >= 0) {
      parsed.pathname = prefixed ? `${prefixed[1]}${clean.slice(0, query)}` : clean.slice(0, query);
      parsed.search = clean.slice(query);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** That URL with a member's ticket on it, when the port has one. */
function withTicket(url: string, ticket: string): string {
  if (!ticket) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("perch_preview", ticket);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function PreviewPane(props: {
  workspaceId: string;
  projectId: string;
  projectName: string;
  /** The port to show; the first one serving otherwise. */
  port: number | null;
  onPort: (port: number) => void;
}) {
  const previews = useQuery(previewsQuery(props.workspaceId, props.projectId));
  const channels = useQuery(channelsQuery(props.workspaceId));
  const ports = useMemo(() => previews.data?.ports ?? [], [previews.data]);
  const chosen = useMemo(
    () => ports.find((p) => p.port === props.port) ?? ports.find((p) => p.runner_id !== "") ?? null,
    [ports, props.port],
  );
  // Our own history, because the iframe's is not ours to read: in wildcard mode the preview has an
  // origin of its own — which is the point — and `contentWindow.history` is then off limits. Back
  // and forward walk the addresses this tab visited; the dev server's own in-page navigations are
  // invisible from here, and that is the price of the isolation.
  const [history, setHistory] = useState<string[]>(["/"]);
  const [cursor, setCursor] = useState(0);
  const path = history[cursor] ?? "/";
  const [typed, setTyped] = useState("/");
  const [viewport, setViewport] = useState<ViewportName>("fit");
  const [landscape, setLandscape] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [sharing, setSharing] = useState(false);
  const addressId = useId();
  const frame = useRef<HTMLIFrameElement | null>(null);
  // The injected client's end of the conversation (task 2.16). `nonce` changes on every reload and
  // every address, which is exactly when the page it was talking to stopped existing.
  const inspector = useInspector(frame, nonce);
  const addChip = useContextChips((store) => store.add);
  const base = chosen?.url ?? "";
  // The ticket rides on the iframe's URL once and becomes a cookie on the preview's own origin,
  // where Perch's session cookie does not reach (ADR-0084).
  const src = base ? withTicket(withPath(base, path), chosen?.ticket ?? "") : "";

  // A new port starts at the path the project's config named.
  useEffect(() => {
    if (!base) return;
    const start = pathOf(base);
    setHistory([start]);
    setCursor(0);
    setTyped(start);
  }, [base]);

  const go = useCallback(
    (next: string) => {
      setHistory((previous) => [...previous.slice(0, cursor + 1), next]);
      setCursor((value) => value + 1);
      setTyped(next);
      setNonce((n) => n + 1);
    },
    [cursor],
  );

  const step = useCallback(
    (by: number) => {
      const next = Math.min(Math.max(cursor + by, 0), history.length - 1);
      setCursor(next);
      setTyped(history[next] ?? "/");
      setNonce((n) => n + 1);
    },
    [cursor, history],
  );

  // ⌘⇧C from the pane as well as from inside the page, so the shortcut works wherever focus is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the toggle is stable per frame
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        inspector.toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspector.toggle]);

  if (previews.isLoading) return <p className="p-4 text-sm text-fg-muted">{t("common.loading")}</p>;
  if (ports.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title={t("preview.emptyTitle")}
          hint={
            previews.data?.config.command
              ? t("preview.startHint", { command: previews.data.config.command })
              : t("preview.emptyHint")
          }
        />
      </div>
    );
  }

  const size = VIEWPORTS[viewport];
  const framed = size
    ? { width: landscape ? size.height : size.width, height: landscape ? size.width : size.height }
    : null;

  return (
    <section aria-label={t("preview.title")} className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("preview.back")}
          disabled={cursor === 0}
          onClick={() => step(-1)}
        >
          ‹
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("preview.forward")}
          disabled={cursor >= history.length - 1}
          onClick={() => step(1)}
        >
          ›
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("preview.reload")}
          onClick={() => setNonce((n) => n + 1)}
        >
          ↻
        </Button>
        <form
          className="flex min-w-40 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            go(typed || "/");
          }}
        >
          <label className="sr-only" htmlFor={addressId}>
            {t("preview.address")}
          </label>
          <Input
            id={addressId}
            value={typed}
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            className="font-mono text-sm"
          />
          <Button type="submit" variant="ghost" size="sm">
            {t("preview.go")}
          </Button>
        </form>
        {ports.length > 1 ? (
          <label className="flex items-center gap-1 text-sm">
            <span className="sr-only">{t("preview.port")}</span>
            <select
              className="h-8 rounded-md border border-border bg-bg px-2 text-sm"
              aria-label={t("preview.port")}
              value={chosen?.port ?? ""}
              onChange={(event) => props.onPort(Number(event.target.value))}
            >
              {ports.map((port) => (
                <option key={port.port} value={port.port}>
                  {port.port}
                  {port.configured ? " ★" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex items-center gap-1 text-sm">
          <span className="sr-only">{t("preview.viewport")}</span>
          <select
            className="h-8 rounded-md border border-border bg-bg px-2 text-sm"
            aria-label={t("preview.viewport")}
            value={viewport}
            onChange={(event) => setViewport(event.target.value as ViewportName)}
          >
            {(Object.keys(VIEWPORTS) as ViewportName[]).map((name) => (
              <option key={name} value={name}>
                {t(`preview.viewport.${name}`)}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("preview.rotate")}
          aria-pressed={landscape}
          disabled={viewport === "fit"}
          onClick={() => setLandscape((value) => !value)}
        >
          ⟲
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={inspector.on}
          disabled={!inspector.ready}
          onClick={inspector.toggle}
        >
          {t("inspect.toggle")}
        </Button>
        <ScreenshotButton
          workspaceId={props.workspaceId}
          projectId={props.projectId}
          port={chosen?.port ?? 0}
          path={path}
          channels={channels.data ?? []}
          onChip={(chip) => addChip(props.projectId, chip)}
        />
        <Button variant="ghost" size="sm" onClick={() => setSharing((value) => !value)}>
          {t("preview.share")}
        </Button>
        <a
          className="rounded-md px-2 py-1 text-sm underline underline-offset-2"
          href={src}
          target="_blank"
          rel="noreferrer"
        >
          {t("preview.newTab")}
        </a>
      </div>

      {sharing && chosen ? (
        <SharePanel
          workspaceId={props.workspaceId}
          projectId={props.projectId}
          port={chosen.port}
          path={path}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 justify-center overflow-auto rounded-md border border-border bg-bg-subtle">
        {src ? (
          <iframe
            key={nonce}
            ref={frame}
            title={t("preview.frame", { name: props.projectName })}
            src={src}
            className="h-full w-full border-0 bg-white"
            style={
              framed ? { width: framed.width, height: framed.height, flex: "none" } : undefined
            }
            // §5.6: the minimum an app needs to run, and nothing that lets it out of the frame.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <p className="p-4 text-sm text-fg-muted">{t("preview.unreachable")}</p>
        )}
      </div>

      {inspector.on || inspector.lines.length > 0 || inspector.failures.length > 0 ? (
        <InspectorPanel
          workspaceId={props.workspaceId}
          projectId={props.projectId}
          state={inspector}
        />
      ) : null}
    </section>
  );
}

/** Share links for one port: make one, copy it once, revoke any of them (spec §5.6). */
function SharePanel(props: { workspaceId: string; projectId: string; port: number; path: string }) {
  const queryClient = useQueryClient();
  const previews = useQuery(previewsQuery(props.workspaceId, props.projectId));
  const [hours, setHours] = useState("24");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hoursId = useId();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["previews", props.workspaceId, props.projectId],
    });

  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/previews/{port}/share", {
          params: {
            path: { ws: props.workspaceId, project: props.projectId, port: props.port },
          },
          body: {
            public: true,
            path: props.path,
            expires_in_hours: Math.max(1, Math.min(720, Number(hours) || 24)),
          },
        }),
      ),
    onSuccess: (share) => {
      setLink(share.url);
      setCopied(false);
      setError(null);
      void invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      unwrap(await api.DELETE("/api/preview-shares/{id}", { params: { path: { id } } }));
    },
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const shares = (previews.data?.shares ?? []).filter((share) => share.port === props.port);

  return (
    <section
      aria-label={t("preview.shareTitle")}
      className="flex flex-col gap-2 rounded-md border border-border p-2"
    >
      <p className="text-sm text-fg-muted">{t("preview.shareHint")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field id={hoursId} label={t("preview.shareHours")}>
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={720}
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              className="w-24"
            />
          )}
        </Field>
        <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
          {t("preview.shareCreate")}
        </Button>
      </div>
      {link ? (
        <div className="flex flex-col gap-1">
          <p className="break-all rounded-md bg-bg-subtle p-2 font-mono text-xs">{link}</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? t("preview.shareCopied") : t("preview.shareCopy")}
            </Button>
            <span className="text-sm text-fg-muted">{t("preview.shareShownOnce")}</span>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {shares.length === 0 ? (
          <li className="text-sm text-fg-subtle">{t("preview.shareEmpty")}</li>
        ) : (
          shares.map((share) => (
            <li key={share.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">
                {share.path} ·{" "}
                {t("preview.shareExpires", {
                  when: new Date(share.expires_at).toLocaleString(),
                })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t("preview.shareRevoke")} ${share.path}`}
                onClick={() => revoke.mutate(share.id)}
              >
                {t("preview.shareRevoke")}
              </Button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
