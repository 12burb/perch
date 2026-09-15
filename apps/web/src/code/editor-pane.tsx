import { Button, EditorGroup, type EditorTab, Input, t } from "@perch/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { fsKey, fsReadQuery } from "../lib/queries.ts";
import { CodeEditor, type CodeEditorHandle } from "./code-editor.tsx";
import { editorFor, isMarkdown, type OpenFile, useEditorStore } from "./editor-store.ts";
import { Markdown } from "./markdown.tsx";

/**
 * The editor for one project (task 1.6): tabs from the store, each file loaded through the api on
 * first open, edited in CodeMirror, saved with ⌘S or the Save button; markdown toggles between
 * source and preview; images and other binaries preview or explain themselves.
 *
 * ⌘K on a selection asks the project's agent to rewrite it (task 1.14): the instruction goes in a
 * bar above the editor, the proposal lands in the buffer with the diff in place, and Accept keeps
 * it (⌘S still writes it) while Reject puts the original back.
 */

/** The life of one ⌘K edit. */
type InlineEdit =
  | { phase: "asking"; from: number; to: number; selection: string }
  | { phase: "running"; from: number; to: number; selection: string; instruction: string }
  | { phase: "proposed"; instruction: string };

/** The fence language for a file, so the agent sees the selection as code. */
function fenceFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return undefined;
  const extension = path.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(extension) ? extension : undefined;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

function extension(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

function imageType(path: string): string | null {
  return IMAGE_TYPES[extension(path)] ?? null;
}

function dataUrl(file: OpenFile, type: string): string {
  if (file.encoding === "base64") return `data:${type};base64,${file.content}`;
  return `data:${type};charset=utf-8,${encodeURIComponent(file.content)}`;
}

function message(err: unknown): string {
  return err instanceof RequestFailed
    ? err.message
    : err instanceof Error
      ? err.message
      : t("common.error");
}

export function EditorPane(props: { workspaceId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const editor = useEditorStore((state) => editorFor(state, props.projectId));
  const { close, select, loaded, failed, edit, saved, setPreview, revealed } = useEditorStore();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const [inline, setInline] = useState<InlineEdit | null>(null);
  const [instruction, setInstruction] = useState("");
  const active = editor.files.find((file) => file.path === editor.active) ?? null;

  // Load every open file that has no content yet.
  useEffect(() => {
    for (const file of editor.files) {
      if (file.loaded) continue;
      queryClient
        .fetchQuery(fsReadQuery(props.workspaceId, props.projectId, file.path))
        .then((result) => loaded(props.projectId, file.path, result))
        .catch((err: unknown) => failed(props.projectId, file.path, message(err)));
    }
  }, [editor.files, failed, loaded, props.projectId, props.workspaceId, queryClient]);

  const save = useMutation({
    mutationFn: async (file: OpenFile) => {
      unwrap(
        await api.PUT("/api/workspaces/{ws}/projects/{project}/fs/write", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { path: file.path, content: file.content, encoding: file.encoding },
        }),
      );
      return file;
    },
    onSuccess: (file) => {
      saved(props.projectId, file.path, file.content);
      setError(null);
      setNotice(t("editor.saved"));
      void queryClient.invalidateQueries({
        queryKey: [...fsKey(props.workspaceId, props.projectId), "read", file.path],
      });
    },
    onError: (err) => setError(message(err)),
  });

  const onSave = useCallback(() => {
    const current = useEditorStore.getState();
    const file = editorFor(current, props.projectId).files.find(
      (f) => f.path === editorFor(current, props.projectId).active,
    );
    if (file?.loaded && file.content !== file.original) save.mutate(file);
  }, [props.projectId, save]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // A file change or a tab switch drops a proposal nobody answered: its range no longer means
  // anything in the new document. This is the backstop for paths that change on their own (a
  // reload, a close); the handlers below reject first, while the proposal's own view is still
  // mounted and can put the original text back.
  const activePath = active?.path ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the proposal belongs to the file it was made in
  useEffect(() => {
    setInline(null);
    setInstruction("");
  }, [activePath]);

  const runInlineEdit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (inline?.phase !== "asking" || !active) return;
      const asked = instruction.trim();
      if (!asked) return;
      setError(null);
      setInline({ ...inline, phase: "running", instruction: asked });
      try {
        const language = fenceFor(active.path);
        const result = unwrap(
          await api.POST("/api/workspaces/{ws}/projects/{project}/inline-edit", {
            params: { path: { ws: props.workspaceId, project: props.projectId } },
            body: {
              path: active.path,
              selection: inline.selection,
              instruction: asked,
              ...(language ? { language } : {}),
            },
          }),
        );
        if (!result.replacement) {
          setInline(null);
          setNotice(t("editor.inline.empty"));
          return;
        }
        // The person may have moved on while the agent was thinking. The file is checked first
        // because `active` here is the one the round started in, not the one on screen now.
        const now = editorFor(useEditorStore.getState(), props.projectId).active;
        if (now !== active.path) return;
        // And they may have typed: only replace the text we sent.
        const placed = editorRef.current?.propose(
          { from: inline.from, to: inline.to },
          result.replacement,
          inline.selection,
        );
        if (!placed) {
          setInline(null);
          setNotice(t("editor.inline.moved"));
          return;
        }
        setInline({ phase: "proposed", instruction: asked });
      } catch (failure) {
        setError(message(failure));
        setInline({ ...inline, phase: "asking" });
      }
    },
    [inline, instruction, active, props.workspaceId, props.projectId],
  );

  const resolveInline = useCallback((action: "accept" | "reject") => {
    editorRef.current?.resolve(action);
    setInline(null);
    setInstruction("");
  }, []);

  // Esc drops a proposal from wherever the person is — the buffer is what it is about, not the bar.
  useEffect(() => {
    if (inline?.phase !== "proposed") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      resolveInline("reject");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline?.phase, resolveInline]);

  const tabs: EditorTab[] = editor.files.map((file) => ({
    id: file.path,
    title: file.path.slice(file.path.lastIndexOf("/") + 1),
    dirty: file.content !== file.original,
  }));

  /**
   * Puts an unanswered proposal back before the editor showing it goes away. React runs the
   * child's teardown first, so an effect is too late: by then the view (and the original text it
   * held) is gone and the agent's rewrite would stay in the buffer (ADR-0080 §5).
   */
  const dropProposal = useCallback(() => {
    if (inline?.phase === "proposed") resolveInline("reject");
  }, [inline?.phase, resolveInline]);

  function onClose(path: string) {
    // Reject first, then ask: putting the original back may be exactly what makes the file clean,
    // and there is nothing to warn about losing then.
    if (path === editor.active) dropProposal();
    const file = editorFor(useEditorStore.getState(), props.projectId).files.find(
      (f) => f.path === path,
    );
    if (file && file.content !== file.original && !window.confirm(t("editor.discardConfirm")))
      return;
    close(props.projectId, path);
  }

  const dirty = active ? active.content !== active.original : false;
  const markdown = active ? isMarkdown(active.path) : false;
  const image = active ? imageType(active.path) : null;

  return (
    <EditorGroup
      tabs={tabs}
      activeId={editor.active}
      onSelect={(id) => {
        if (id !== editor.active) dropProposal();
        select(props.projectId, id);
      }}
      onClose={onClose}
      breadcrumbs={active?.path.split("/")}
      actions={
        active ? (
          <>
            {notice ? (
              <span role="status" className="text-xs text-fg-muted" data-testid="editor-notice">
                {notice}
              </span>
            ) : null}
            {error ? (
              <span role="alert" className="text-xs text-danger">
                {error}
              </span>
            ) : null}
            {markdown ? (
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={active.preview}
                onClick={() => {
                  // Preview unmounts the editor, so a standing proposal goes back first.
                  dropProposal();
                  setPreview(props.projectId, active.path, !active.preview);
                }}
              >
                {active.preview ? t("editor.source") : t("editor.preview")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || save.isPending || !active.loaded}
              onClick={onSave}
            >
              {t("editor.save")}
            </Button>
          </>
        ) : null
      }
    >
      {active ? (
        !active.loaded ? (
          <p className="p-3 text-sm text-fg-muted" role="status">
            {t("editor.loading", { name: active.path })}
          </p>
        ) : active.error ? (
          <p className="p-3 text-sm text-danger" role="alert">
            {active.error}
          </p>
        ) : image ? (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={dataUrl(active, image)}
              alt={t("editor.imageAlt", { name: active.path })}
              className="max-h-full max-w-full"
              data-testid="image-preview"
            />
          </div>
        ) : active.encoding === "base64" ? (
          <p className="p-3 text-sm text-fg-muted">{t("editor.binary")}</p>
        ) : markdown && active.preview ? (
          <Markdown source={active.content} className="prose-perch p-4" />
        ) : (
          <div className="flex h-full flex-col">
            {active.truncated ? (
              <p className="border-b border-border px-3 py-1 text-xs text-warning" role="status">
                {t("editor.truncated")}
              </p>
            ) : null}
            {inline ? (
              <div className="border-border border-b px-3 py-2" data-testid="inline-edit">
                {inline.phase === "proposed" ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-fg-muted text-xs" role="status">
                      {t("editor.inline.proposed")}: {inline.instruction}
                    </span>
                    <Button size="sm" variant="primary" onClick={() => resolveInline("accept")}>
                      {t("editor.inline.accept")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => resolveInline("reject")}>
                      {t("editor.inline.reject")}
                    </Button>
                  </div>
                ) : (
                  <form
                    className="flex items-center gap-2"
                    aria-label={t("editor.inline.label")}
                    onSubmit={(event) => void runInlineEdit(event)}
                  >
                    <Input
                      aria-label={t("editor.inline.instruction")}
                      placeholder={t("editor.inline.placeholder")}
                      className="h-8 flex-1"
                      value={instruction}
                      disabled={inline.phase === "running"}
                      autoFocus
                      onChange={(event) => setInstruction(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        resolveInline("reject");
                      }}
                    />
                    <Button size="sm" type="submit" disabled={inline.phase === "running"}>
                      {inline.phase === "running"
                        ? t("editor.inline.running")
                        : t("editor.inline.send")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => resolveInline("reject")}
                    >
                      {t("common.cancel")}
                    </Button>
                  </form>
                )}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <CodeEditor
                ref={editorRef}
                path={active.path}
                value={active.content}
                readOnly={active.truncated}
                onChange={(value) => edit(props.projectId, active.path, value)}
                onSave={onSave}
                revealLine={active.revealLine}
                onRevealed={() => revealed(props.projectId, active.path)}
                label={active.path}
                onInlineEdit={(selection) => {
                  // One proposal at a time: asking again puts the unanswered one back first,
                  // otherwise its original text is lost and Cancel would revert the wrong range.
                  dropProposal();
                  setInstruction("");
                  setError(null);
                  setInline({ phase: "asking", ...selection, selection: selection.text });
                }}
              />
            </div>
          </div>
        )
      ) : null}
    </EditorGroup>
  );
}
