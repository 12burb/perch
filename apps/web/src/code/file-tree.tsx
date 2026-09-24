import { Button, Input, t } from "@perch/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, File, Folder, Search } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RequestFailed } from "../lib/api.ts";
import { type FsEntry, fsKey, fsListQuery, fsSearchQuery } from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";

/**
 * The file tree (spec §4 Code sidebar, task 1.6): directories load when expanded, the visible rows
 * are virtualized, and the whole thing is a keyboard-navigable ARIA tree. A project-wide search
 * box (fs.search on the runner) lists matches that open at their line.
 */

export type FileTreeProps = {
  workspaceId: string;
  projectId: string;
  onOpen: (path: string, line?: number) => void;
  selectedPath?: string | null;
};

type Row = { path: string; name: string; depth: number; entry: FsEntry; expanded: boolean };

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Why a listing or a search failed: the api's own words (a runner offline, a timeout). */
function failure(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

export function FileTree(props: FileTreeProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [listings, setListings] = useState<Map<string, FsEntry[]>>(() => new Map());
  const [focused, setFocused] = useState(0);
  const [query, setQuery] = useState("");
  const root = useQuery(fsListQuery(props.workspaceId, props.projectId, ""));

  const load = useCallback(
    async (dir: string) => {
      const entries = await queryClient.fetchQuery(
        fsListQuery(props.workspaceId, props.projectId, dir),
      );
      setListings((current) => new Map(current).set(dir, entries));
    },
    [props.projectId, props.workspaceId, queryClient],
  );

  // Edits and uploads change the tree: refetch what is expanded when the project's files change.
  useEffect(() => {
    const socket = getSocket();
    socket.subscribe(`ws:${props.workspaceId}`);
    return socket.onEvent((envelope) => {
      const payload = envelope.payload as { projectId?: string; changes?: string[] };
      if (
        envelope.type === "project.updated" &&
        payload.projectId === props.projectId &&
        payload.changes?.includes("files")
      ) {
        void queryClient.invalidateQueries({ queryKey: fsKey(props.workspaceId, props.projectId) });
        for (const dir of ["", ...expanded]) void load(dir);
      }
    });
  }, [expanded, load, props.projectId, props.workspaceId, queryClient]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const entries = dir === "" ? (root.data ?? []) : (listings.get(dir) ?? []);
      for (const entry of entries) {
        const path = join(dir, entry.name);
        const isDir = entry.type === "dir";
        const open = isDir && expanded.has(path);
        out.push({ path, name: entry.name, depth, entry, expanded: open });
        if (open) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [expanded, listings, root.data]);

  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const toggle = useCallback(
    (row: Row) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(row.path)) next.delete(row.path);
        else next.add(row.path);
        return next;
      });
      if (!expanded.has(row.path) && !listings.has(row.path)) void load(row.path);
    },
    [expanded, listings, load],
  );

  function activate(row: Row) {
    if (row.entry.type === "dir") toggle(row);
    else props.onOpen(row.path);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const row = rows[focused];
    if (!row) return;
    let next = focused;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(focused + 1, rows.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(focused - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      case "ArrowRight":
        if (row.entry.type === "dir" && !row.expanded) toggle(row);
        else if (row.entry.type === "dir") next = Math.min(focused + 1, rows.length - 1);
        break;
      case "ArrowLeft":
        if (row.entry.type === "dir" && row.expanded) toggle(row);
        else {
          const parent = row.path.split("/").slice(0, -1).join("/");
          const index = rows.findIndex((r) => r.path === parent);
          if (index >= 0) next = index;
        }
        break;
      case "Enter":
      case " ":
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== focused) {
      setFocused(next);
      virtualizer.scrollToIndex(next);
      requestAnimationFrame(() => {
        scroller.current
          ?.querySelector<HTMLElement>(`[role="treeitem"][data-index="${next}"]`)
          ?.focus();
      });
    }
  }

  const search = useQuery(fsSearchQuery(props.workspaceId, props.projectId, query));
  const matches = search.data?.matches ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex items-center gap-1 px-2 pb-2"
        onSubmit={(event) => event.preventDefault()}
      >
        <label htmlFor="file-search" className="sr-only">
          {t("files.search")}
        </label>
        <Input
          id="file-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("files.searchPlaceholder")}
          autoComplete="off"
          className="h-8"
        />
        <Search className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
      </form>
      {query.trim() ? (
        <div className="min-h-0 flex-1 overflow-auto px-2" data-testid="file-search-results">
          {search.isError && !search.isFetching ? (
            // A failed search is not an empty one: say what went wrong instead of "No matches".
            <p className="px-1 py-1 text-sm text-danger" role="alert">
              {failure(search.error)}
            </p>
          ) : (
            <p className="px-1 py-1 text-sm text-fg-muted" role="status">
              {search.isFetching
                ? t("common.loading")
                : matches.length === 0
                  ? t("files.searchEmpty")
                  : t("files.searchResults", { count: matches.length })}
            </p>
          )}
          <ul aria-label={t("files.search")} className="flex flex-col">
            {matches.map((match) => (
              <li key={`${match.path}:${match.line}:${match.column}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start py-1 text-left"
                  onClick={() => props.onOpen(match.path, match.line)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">
                      {match.path}
                      <span className="text-fg-muted">:{match.line}</span>
                    </span>
                    <span className="truncate font-mono text-xs text-fg-muted">{match.text}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          {search.data?.truncated ? (
            <p className="px-1 py-1 text-xs text-fg-muted">
              {t("files.searchTruncated", { count: matches.length })}
            </p>
          ) : null}
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
          {root.isError ? (
            <p className="px-3 py-2 text-sm text-danger" role="alert">
              {failure(root.error)}
            </p>
          ) : root.isSuccess && rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-fg-subtle">{t("files.empty")}</p>
          ) : null}
          <div
            role="tree"
            aria-label={t("files.title")}
            onKeyDown={onKeyDown}
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const isDir = row.entry.type === "dir";
              const selected = props.selectedPath === row.path;
              return (
                <div
                  key={row.path}
                  role="treeitem"
                  data-index={item.index}
                  data-path={row.path}
                  aria-level={row.depth + 1}
                  aria-expanded={isDir ? row.expanded : undefined}
                  aria-selected={selected}
                  tabIndex={item.index === focused ? 0 : -1}
                  onFocus={() => setFocused(item.index)}
                  onClick={() => activate(row)}
                  onKeyDown={undefined}
                  className={`absolute left-0 flex w-full cursor-default items-center gap-1 pr-2 text-sm hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus ${selected ? "bg-accent-soft text-accent" : ""}`}
                  style={{
                    top: item.start,
                    height: item.size,
                    paddingLeft: 8 + row.depth * 14,
                  }}
                >
                  {isDir ? (
                    row.expanded ? (
                      <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                    )
                  ) : (
                    <span className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {isDir ? (
                    <Folder className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
                  ) : (
                    <File className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
                  )}
                  <span className="truncate">{row.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
