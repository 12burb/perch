import { Button, EditorGroup, type EditorTab, t } from "@perch/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { fsKey, fsReadQuery } from "../lib/queries.ts";
import { CodeEditor } from "./code-editor.tsx";
import { editorFor, isMarkdown, type OpenFile, useEditorStore } from "./editor-store.ts";
import { Markdown } from "./markdown.tsx";

/**
 * The editor for one project (task 1.6): tabs from the store, each file loaded through the api on
 * first open, edited in CodeMirror, saved with ⌘S or the Save button; markdown toggles between
 * source and preview; images and other binaries preview or explain themselves.
 */

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

  const tabs: EditorTab[] = editor.files.map((file) => ({
    id: file.path,
    title: file.path.slice(file.path.lastIndexOf("/") + 1),
    dirty: file.content !== file.original,
  }));

  function onClose(path: string) {
    const file = editor.files.find((f) => f.path === path);
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
      onSelect={(id) => select(props.projectId, id)}
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
                onClick={() => setPreview(props.projectId, active.path, !active.preview)}
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
            <div className="min-h-0 flex-1">
              <CodeEditor
                path={active.path}
                value={active.content}
                readOnly={active.truncated}
                onChange={(value) => edit(props.projectId, active.path, value)}
                onSave={onSave}
                revealLine={active.revealLine}
                onRevealed={() => revealed(props.projectId, active.path)}
                label={active.path}
              />
            </div>
          </div>
        )
      ) : null}
    </EditorGroup>
  );
}
