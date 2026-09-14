import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { deployKeyQuery, type ProjectRow, projectsQuery } from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";

/**
 * Projects in Code mode (spec §5.1, task 1.4): the workspace's projects with their live setup status,
 * and a form that creates one empty, clones a repository (public, with a token, or with the workspace
 * deploy key), or uploads files into a fresh one.
 */

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

/** Refetches the list whenever a project.* event arrives on the workspace topic. */
function useLiveProjects(workspaceId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    socket.subscribe(`ws:${workspaceId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic === `ws:${workspaceId}` && envelope.type.startsWith("project.")) {
        void queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId, "projects"] });
      }
    });
  }, [queryClient, workspaceId]);
}

const STATUS_TONE: Record<ProjectRow["status"], "neutral" | "success" | "danger" | "warning"> = {
  pending: "neutral",
  setting_up: "warning",
  ready: "success",
  error: "danger",
};

export function ProjectList(props: {
  workspaceId: string;
  workspaceSlug: string;
  canDelete: boolean;
}) {
  useLiveProjects(props.workspaceId);
  const queryClient = useQueryClient();
  const projects = useQuery(projectsQuery(props.workspaceId));
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: async (projectId: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/projects/{project}", {
        params: { path: { ws: props.workspaceId, project: projectId } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
      return projectId;
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "projects"],
      });
    },
    onError: (err) => setError(message(err)),
  });
  const rows = projects.data ?? [];
  if (projects.isSuccess && rows.length === 0) {
    return <EmptyState title={t("projects.empty")} hint={t("projects.emptyHint")} />;
  }
  return (
    // Not a named landmark: the sidebar's Projects section already is one (axe landmark-unique).
    <section className="flex flex-col gap-3">
      <h2 className="text-md font-semibold">{t("projects.title")}</h2>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <table className="w-full table-fixed text-sm break-words">
          <thead>
            <tr className="text-left text-fg-muted">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("projects.name")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("projects.status")}
              </th>
              <th scope="col" className="hidden py-1 pr-3 font-medium sm:table-cell">
                {t("projects.branchColumn")}
              </th>
              <th scope="col" className="hidden py-1 pr-3 font-medium sm:table-cell">
                {t("projects.engine")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                <span className="sr-only">{t("settings.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((project) => (
              <tr key={project.id} className="border-t border-border" data-testid="project-row">
                <td className="py-2 pr-3">
                  {project.status === "ready" ? (
                    <Link
                      to="/$workspace/code/$project"
                      params={{ workspace: props.workspaceSlug, project: project.key }}
                      className="font-medium hover:underline"
                      aria-label={t("projects.open", { name: project.name })}
                    >
                      {project.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{project.name}</span>
                  )}
                  <span className="ml-2 text-fg-muted">{project.key}</span>
                </td>
                <td className="py-2 pr-3">
                  <Badge tone={STATUS_TONE[project.status]} data-testid="project-status">
                    {t(`projects.status.${project.status}`)}
                  </Badge>
                  {project.status_message ? (
                    <p className="mt-1 text-xs text-fg-muted" data-testid="project-message">
                      {project.status_message}
                    </p>
                  ) : null}
                </td>
                <td className="hidden py-2 pr-3 sm:table-cell">
                  {project.default_branch}
                  {project.head ? (
                    <span className="ml-1 font-mono text-fg-muted">{project.head.slice(0, 7)}</span>
                  ) : null}
                </td>
                <td className="hidden py-2 pr-3 sm:table-cell">{project.default_engine}</td>
                <td className="py-2 text-right">
                  {props.canDelete ? (
                    <Button
                      variant="danger"
                      size="sm"
                      aria-label={t("projects.deleteOf", { name: project.name })}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(project.id)}
                    >
                      {t("projects.delete")}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type Source = "empty" | "clone" | "upload";
type Auth = "none" | "token" | "deploy_key";

function DeployKeyCard(props: { workspaceId: string; canRotate: boolean }) {
  const queryClient = useQueryClient();
  const key = useQuery(deployKeyQuery(props.workspaceId));
  const [copied, setCopied] = useState(false);
  const rotate = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/deploy-key/rotate", {
          params: { path: { ws: props.workspaceId } },
        }),
      ),
    onSuccess: async () => {
      setCopied(false);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "deploy-key"],
      });
    },
  });
  async function copy() {
    if (!key.data) return;
    try {
      await navigator.clipboard.writeText(key.data.public_key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded border border-border bg-raised p-3">
      <h3 className="text-sm font-semibold">{t("projects.deployKeyHeading")}</h3>
      <pre className="whitespace-pre-wrap break-all text-xs">
        <code data-testid="deploy-key">{key.data?.public_key ?? t("common.loading")}</code>
      </pre>
      <p className="text-xs text-fg-muted">
        {t("projects.deployKeyHint")}
        {key.data ? <span className="ml-1 font-mono">{key.data.fingerprint}</span> : null}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void copy()}>
          {t("common.copy")}
        </Button>
        {copied ? (
          <span role="status" className="text-sm text-fg-muted">
            {t("projects.copied")}
          </span>
        ) : null}
        {props.canRotate ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {t("projects.rotateKey")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

async function waitUntilReady(workspaceId: string, projectId: string): Promise<ProjectRow> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const project = unwrap(
      await api.GET("/api/workspaces/{ws}/projects/{project}", {
        params: { path: { ws: workspaceId, project: projectId } },
      }),
    );
    if (project.status === "ready") return project;
    if (project.status === "error") throw new Error(project.status_message ?? t("common.error"));
    if (Date.now() > deadline) throw new Error(t("projects.notReady"));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Each file is one multipart part named `file`; its filename carries the path inside the project. */
function uploadForm(files: File[]): FormData {
  const form = new FormData();
  for (const file of files) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    form.append("file", file, path);
  }
  return form;
}

export function NewProjectSection(props: { workspaceId: string; canRotateKey: boolean }) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Source>("empty");
  const [auth, setAuth] = useState<Auth>("none");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "projects"] });

  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const name = String(form.get("name") ?? "").trim();
      const branch = String(form.get("branch") ?? "").trim();
      if (source === "clone") {
        const token = String(form.get("token") ?? "");
        const authBody =
          auth === "token"
            ? { kind: "token" as const, token }
            : auth === "deploy_key"
              ? { kind: "deploy_key" as const }
              : undefined;
        return unwrap(
          await api.POST("/api/workspaces/{ws}/projects/clone", {
            params: { path: { ws: props.workspaceId } },
            body: {
              name,
              repo_url: String(form.get("repo_url") ?? "").trim(),
              ...(branch ? { branch } : {}),
              ...(authBody ? { auth: authBody } : {}),
            },
          }),
        );
      }
      const created = unwrap(
        await api.POST("/api/workspaces/{ws}/projects", {
          params: { path: { ws: props.workspaceId } },
          body: {
            name,
            source,
            ...(source === "empty" && branch ? { default_branch: branch } : {}),
          },
        }),
      );
      if (source === "upload" && files.length > 0) {
        await invalidate();
        setNotice(t("projects.uploading", { count: files.length }));
        await waitUntilReady(props.workspaceId, created.id);
        unwrap(
          await api.POST("/api/workspaces/{ws}/projects/{project}/files", {
            params: { path: { ws: props.workspaceId, project: created.id } },
            // openapi-fetch serializes the typed body; the wire format is multipart.
            body: { file: [] },
            bodySerializer: () => uploadForm(files),
          }),
        );
        setNotice(t("projects.uploaded", { count: files.length }));
      }
      return created;
    },
    onSuccess: async () => {
      setError(null);
      setFiles([]);
      await invalidate();
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof Error ? err.message : message(err));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setNotice(null);
    create.mutate(new FormData(form), { onSuccess: () => form.reset() });
  }
  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.currentTarget.files ?? []));
  }

  const sources: Source[] = ["empty", "clone", "upload"];
  const auths: Auth[] = ["none", "token", "deploy_key"];
  const authKey = (value: Auth) => (value === "deploy_key" ? "deployKey" : value);
  return (
    <section aria-labelledby="new-project-heading" className="flex max-w-2xl flex-col gap-3">
      <h2 id="new-project-heading" className="text-md font-semibold">
        {t("projects.newHeading")}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field id="project-name" label={t("projects.name")}>
          {(control) => (
            <Input {...control} name="name" required maxLength={80} autoComplete="off" />
          )}
        </Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t("projects.source")}</legend>
          <div className="flex flex-wrap gap-4">
            {sources.map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="source"
                  value={value}
                  checked={source === value}
                  onChange={() => setSource(value)}
                />
                {t(`projects.source.${value}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {source === "empty" ? (
          <Field id="project-default-branch" label={t("projects.defaultBranch")}>
            {(control) => (
              <Input
                {...control}
                name="branch"
                placeholder="main"
                maxLength={200}
                autoComplete="off"
              />
            )}
          </Field>
        ) : null}
        {source === "clone" ? (
          <>
            <Field
              id="project-repo-url"
              label={t("projects.repoUrl")}
              hint={t("projects.repoUrlHint")}
            >
              {(control) => (
                <Input {...control} name="repo_url" required maxLength={2048} autoComplete="off" />
              )}
            </Field>
            <Field id="project-branch" label={t("projects.branch")}>
              {(control) => <Input {...control} name="branch" maxLength={200} autoComplete="off" />}
            </Field>
            <Field id="project-auth" label={t("projects.auth")}>
              {(control) => (
                <select
                  {...control}
                  name="auth"
                  value={auth}
                  onChange={(event) => setAuth(event.currentTarget.value as Auth)}
                  className="min-h-row rounded border border-border bg-surface px-2 text-md"
                >
                  {auths.map((value) => (
                    <option key={value} value={value}>
                      {t(`projects.auth.${authKey(value)}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {auth === "token" ? (
              <Field id="project-token" label={t("projects.token")} hint={t("projects.tokenHint")}>
                {(control) => (
                  <Input {...control} name="token" type="password" required autoComplete="off" />
                )}
              </Field>
            ) : null}
            {auth === "deploy_key" ? (
              <DeployKeyCard workspaceId={props.workspaceId} canRotate={props.canRotateKey} />
            ) : null}
          </>
        ) : null}
        {source === "upload" ? (
          <Field id="project-files" label={t("projects.files")} hint={t("projects.filesHint")}>
            {(control) => (
              <input
                {...control}
                type="file"
                name="files"
                multiple
                onChange={onFiles}
                className="text-sm"
              />
            )}
          </Field>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-fg-muted">
            {notice}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? t("projects.creating") : t("projects.create")}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Code mode's main column until the editor lands: the projects and the form. */
export function ProjectsMain(props: {
  workspaceId: string;
  workspaceSlug: string;
  canAdmin: boolean;
}) {
  return (
    <div className="flex flex-col gap-8 p-4">
      <ProjectList
        workspaceId={props.workspaceId}
        workspaceSlug={props.workspaceSlug}
        canDelete={props.canAdmin}
      />
      <NewProjectSection workspaceId={props.workspaceId} canRotateKey={props.canAdmin} />
    </div>
  );
}
