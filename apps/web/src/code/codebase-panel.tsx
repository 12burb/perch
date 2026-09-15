/**
 * The codebase index, in Code mode (spec §5.7; task 2.17).
 *
 * One drawer tab for the three things a person does with an index: see whether there is one, ask it
 * a question, and open what it answers. Asking here and asking with `@codebase` in a session hit the
 * same rows, so what this panel shows is exactly what an agent would have been handed — which is the
 * point of showing it at all.
 *
 * The AGENTS.md draft lives here too: it is built from the same walk of the repository, and the
 * place you are looking at the repository is the place to be offered one.
 */
import "@perch/ui/i18n/code";
import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";

function message(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

type Hit = {
  path: string;
  symbol: string | null;
  kind: "symbol" | "chunk" | "doc";
  start_line: number;
  end_line: number;
  content: string;
  score: number;
};

export function CodebasePanel(props: {
  workspaceId: string;
  projectId: string;
  onOpenPath: (path: string, line: number) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = ["workspace", props.workspaceId, "projects", props.projectId, "index"];

  const status = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/index", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
        }),
      ),
  });

  // Waiting for the pass is what makes the panel's numbers true when it returns; a repository too
  // big to wait for is what the queued form of this route is for, and the bus says when it lands.
  const index = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/index", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { wait: true },
        }),
      ),
    onSuccess: async (result) => {
      setError(result.embedding_skipped);
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setError(message(err)),
  });

  const ask = useMutation({
    mutationFn: async (q: string) =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/codebase", {
          params: { path: { ws: props.workspaceId, project: props.projectId }, query: { q } },
        }),
      ),
    onSuccess: (result) => {
      setError(null);
      setHits(result.hits);
    },
    onError: (err) => {
      setHits(null);
      setError(message(err));
    },
  });

  const agents = useMutation({
    mutationFn: async (save: boolean) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/agents-draft", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { save },
        }),
      ),
    onSuccess: (result) => {
      setError(null);
      setDraft(result.markdown);
    },
    onError: (err) => setError(message(err)),
  });

  const indexed = (status.data?.chunks ?? 0) > 0;

  return (
    <section aria-label={t("codebase.title")} className="flex flex-col gap-3 p-2">
      <div className="flex flex-wrap items-center gap-2">
        {indexed ? (
          <>
            <Badge tone="success">
              {t("codebase.indexed", {
                files: String(status.data?.files ?? 0),
                chunks: String(status.data?.chunks ?? 0),
              })}
            </Badge>
            {status.data?.embedded ? (
              <Badge tone="accent">
                {t("codebase.embedded", { model: status.data.embedding_model ?? "" })}
              </Badge>
            ) : (
              <Badge tone="neutral">{t("codebase.wordsOnly")}</Badge>
            )}
          </>
        ) : (
          <Badge tone="neutral">{t("codebase.notIndexed")}</Badge>
        )}
        <Button onClick={() => index.mutate()} disabled={index.isPending}>
          {index.isPending ? t("codebase.indexing") : t("codebase.index")}
        </Button>
        <Button variant="ghost" onClick={() => agents.mutate(false)} disabled={agents.isPending}>
          {t("codebase.draft")}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">{t("codebase.hint")}</p>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = question.trim();
          if (value) ask.mutate(value);
        }}
      >
        <Field id={`${id}-q`} label={t("codebase.ask")}>
          {(control) => (
            <Input
              {...control}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t("codebase.askPlaceholder")}
              spellCheck={false}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={ask.isPending || !question.trim()}>
          {t("codebase.search")}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {hits && hits.length === 0 ? (
        <EmptyState title={t("codebase.noHits")} hint={t("codebase.noHitsHint")} />
      ) : null}

      {hits && hits.length > 0 ? (
        <ul aria-label={t("codebase.results")} className="flex flex-col gap-2">
          {hits.map((hit) => (
            <li key={`${hit.path}:${hit.start_line}`} className="rounded border border-border">
              <button
                type="button"
                className="flex w-full flex-col gap-1 p-2 text-left hover:bg-surface-hover"
                onClick={() => props.onOpenPath(hit.path, hit.start_line)}
              >
                <span className="font-mono text-sm">
                  {hit.path}:{hit.start_line}
                  {hit.symbol ? <span className="text-fg-muted"> — {hit.symbol}</span> : null}
                </span>
                <span className="line-clamp-3 whitespace-pre-wrap font-mono text-xs text-fg-muted">
                  {hit.content.slice(0, 400)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg-muted">{t("codebase.draftHint")}</p>
          <textarea
            aria-label={t("codebase.draftLabel")}
            readOnly
            value={draft}
            rows={12}
            className="w-full rounded border border-border bg-surface p-2 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button onClick={() => agents.mutate(true)} disabled={agents.isPending}>
              {t("codebase.draftSave")}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t("common.close")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
