import "@perch/ui/i18n/code";
import { Button, t } from "@perch/ui";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ILink, type ILinkProvider, Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { useTerminalQueue } from "./terminal-store.ts";

/**
 * The terminal drawer (spec §5.1, task 1.7): xterm.js over the project terminal socket. The
 * pty_id lives in sessionStorage per project, so a reload (or closing and reopening the drawer)
 * reattaches to the same shell with its scrollback. File paths in the output are links that open
 * the editor.
 */

export type TerminalProps = {
  workspaceId: string;
  projectId: string;
  projectName: string;
  /** Opens a project-relative path in the editor (with a line when the link had one). */
  onOpenPath: (path: string, line?: number) => void;
};

type Status = "connecting" | "connected" | "reattached" | "ended" | "disconnected" | "error";

type ServerFrame =
  | { t: "open"; pty_id: string; reattached: boolean }
  | { t: "o"; d: string }
  | { t: "x" }
  | { t: "e"; message: string; code?: string };

const PATH_PATTERN = /(?:\.{1,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?(?::\d+)?/g;
const NOT_A_FILE = /^(?:\d+\.\d+|[\w.-]+\.(?:com|org|net|io|dev|local))$/i;

function storageKey(projectId: string): string {
  return `perch.pty.${projectId}`;
}

function readPtyId(projectId: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(projectId));
  } catch {
    return null;
  }
}

function writePtyId(projectId: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(storageKey(projectId), id);
    else sessionStorage.removeItem(storageKey(projectId));
  } catch {
    // storage unavailable: the shell lasts for the tab
  }
}

/** File paths in the output become links that open the editor. */
function pathLinkProvider(
  term: Terminal,
  onOpen: (path: string, line?: number) => void,
): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links: ILink[] = [];
      for (const match of text.matchAll(PATH_PATTERN)) {
        const raw = match[0];
        if (NOT_A_FILE.test(raw) || raw.startsWith("http")) continue;
        const [pathPart, linePart] = raw.split(":");
        if (!pathPart) continue;
        const start = match.index ?? 0;
        const path = pathPart.replace(/^\.\//, "");
        const line = linePart ? Number(linePart) : undefined;
        links.push({
          range: {
            start: { x: start + 1, y: lineNumber },
            end: { x: start + raw.length, y: lineNumber },
          },
          text: raw,
          decorations: { underline: true, pointerCursor: true },
          activate: () => onOpen(path, line),
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}

function themeFromTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--color-surface", "#0b0f14"),
    foreground: read("--color-fg", "#e6edf3"),
    cursor: read("--color-accent", "#58a6ff"),
    selectionBackground: read("--color-accent-soft", "#1f3b5a"),
  };
}

export function TerminalDrawer(props: TerminalProps) {
  const host = useRef<HTMLElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  /**
   * Bumped to connect again. Reconnect reattaches to the saved shell (task 1.7: the shell outlives
   * a dropped socket); only Restart forgets it, and it does so itself before bumping this, so a
   * later project switch in the same drawer still reattaches that project's shell.
   */
  const [generation, setGeneration] = useState(0);
  const latest = useRef(props);
  latest.current = props;

  const connect = useCallback((term: Terminal, fit: FitAddon, projectId: string) => {
    socketRef.current?.close();
    const { workspaceId } = latest.current;
    const ptyId = readPtyId(projectId);
    fit.fit();
    const params = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) });
    if (ptyId) params.set("pty_id", ptyId);
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/api/workspaces/${workspaceId}/projects/${projectId}/terminal?${params}`,
    );
    socketRef.current = socket;
    setStatus("connecting");
    setMessage(null);
    socket.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.t === "open") {
        writePtyId(projectId, frame.pty_id);
        // The queued commands follow from the status (see the effect below).
        setStatus(frame.reattached ? "reattached" : "connected");
      } else if (frame.t === "o") {
        term.write(frame.d);
      } else if (frame.t === "x") {
        writePtyId(projectId, null);
        setStatus("ended");
      } else if (frame.t === "e") {
        writePtyId(projectId, null);
        setStatus("error");
        setMessage(frame.message);
      }
    };
    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      setStatus((current) =>
        current === "ended" || current === "error" ? current : "disconnected",
      );
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the signal to connect again (Reconnect, Restart)
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 5_000,
      theme: themeFromTokens(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.registerLinkProvider(
      pathLinkProvider(term, (path, line) => latest.current.onOpenPath(path, line)),
    );
    term.open(parent);
    termRef.current = term;
    term.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "i", d: data }));
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
      }
    });
    observer.observe(parent);
    connect(term, fit, props.projectId);
    return () => {
      observer.disconnect();
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [connect, props.projectId, generation]);

  // A quick action of the `run` kind is typed here, where its output belongs (task 2.18): as soon
  // as a shell is there to take it, whether the command was queued before the drawer opened or
  // while the terminal was already connected.
  const waiting = useTerminalQueue((store) => store.queued[props.projectId]);
  useEffect(() => {
    if (!waiting || waiting.length === 0) return;
    if (status !== "connected" && status !== "reattached") return;
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (const command of useTerminalQueue.getState().take(props.projectId)) {
      socket.send(JSON.stringify({ t: "i", d: `${command}\r` }));
    }
  }, [waiting, status, props.projectId]);

  const statusText: Record<Status, string> = {
    connecting: t("terminal.connecting"),
    connected: t("terminal.connected"),
    reattached: t("terminal.reattached"),
    ended: t("terminal.ended"),
    disconnected: t("terminal.disconnected"),
    error: message ?? t("common.error"),
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="terminal">
      <div className="flex min-h-7 items-center gap-2 px-2 text-xs text-fg-muted">
        <span role="status" data-testid="terminal-status">
          {statusText[status]}
        </span>
        {status === "ended" || status === "error" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              writePtyId(props.projectId, null);
              setGeneration((n) => n + 1);
            }}
          >
            {t("terminal.restart")}
          </Button>
        ) : null}
        {status === "disconnected" ? (
          <Button size="sm" variant="ghost" onClick={() => setGeneration((n) => n + 1)}>
            {t("terminal.reconnect")}
          </Button>
        ) : null}
      </div>
      <section
        ref={host}
        className="min-h-0 flex-1 px-2 pb-2"
        aria-label={t("terminal.label", { name: props.projectName })}
        data-testid="terminal-screen"
      />
    </div>
  );
}
