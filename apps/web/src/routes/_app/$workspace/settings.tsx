import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { BotsSection } from "../../../components/bots-section.tsx";
import { BrainsSection } from "../../../components/brains-section.tsx";
import { ConnectionsSection } from "../../../components/connections-section.tsx";
import { PolicySection } from "../../../components/policy-section.tsx";
import { api, RequestFailed, unwrap } from "../../../lib/api.ts";
import { connectOutcome } from "../../../lib/connect-outcome.ts";
import { auditQuery, type Member, membersQuery } from "../../../lib/queries.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

export const Route = createFileRoute("/_app/$workspace/settings")({
  // A provider's callback lands on /connections and is sent here with how it went (task 2.14).
  validateSearch: connectOutcome,
  component: WorkspaceSettings,
});

const ROLES = ["owner", "admin", "member"] as const;
type Role = (typeof ROLES)[number];

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

function WorkspaceSettings() {
  const { shell, workspace, me } = useAppShell();
  if (!workspace) return null;
  const canAdmin = workspace.role !== "member";
  return (
    <ModePage title={t("settings.workspace")} subtitle={workspace.name} shell={shell}>
      <div className="flex flex-col gap-8 p-4">
        <GeneralSection
          workspaceId={workspace.id}
          name={workspace.name}
          slug={workspace.slug}
          canAdmin={canAdmin}
        />
        <MembersSection workspaceId={workspace.id} myId={me.id} myRole={workspace.role} />
        <BrainsSection workspaceId={workspace.id} canAdmin={canAdmin} />
        <BotsSection workspaceId={workspace.id} canAdmin={canAdmin} />
        <ConnectionsSection workspaceId={workspace.id} canAdmin={canAdmin} />
        <PolicySection workspaceId={workspace.id} canAdmin={canAdmin} />
        {canAdmin ? <InviteSection workspaceId={workspace.id} myRole={workspace.role} /> : null}
        {canAdmin ? <AuditSection workspaceId={workspace.id} /> : null}
      </div>
    </ModePage>
  );
}

function GeneralSection(props: {
  workspaceId: string;
  name: string;
  slug: string;
  canAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = useMutation({
    mutationFn: async (body: { name: string; slug: string }) =>
      unwrap(
        await api.PATCH("/api/workspaces/{ws}", {
          params: { path: { ws: props.workspaceId } },
          body,
        }),
      ),
    onSuccess: async (ws) => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      if (ws.slug !== props.slug) {
        await navigate({ to: "/$workspace/settings", params: { workspace: ws.slug } });
      }
    },
    onError: (err) => setError(message(err)),
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    update.mutate({
      name: String(data.get("name") ?? "").trim(),
      slug: String(data.get("slug") ?? "").trim(),
    });
  }
  return (
    <section aria-labelledby="general-heading" className="flex max-w-lg flex-col gap-3">
      <h2 id="general-heading" className="text-md font-semibold">
        {t("settings.general")}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field id="ws-name" label={t("home.workspaceName")}>
          {(control) => (
            <Input
              {...control}
              name="name"
              defaultValue={props.name}
              required
              maxLength={80}
              disabled={!props.canAdmin}
            />
          )}
        </Field>
        <Field id="ws-slug" label={t("settings.slug")} hint={t("settings.slugHint")} error={error}>
          {(control) => (
            <Input
              {...control}
              name="slug"
              defaultValue={props.slug}
              required
              maxLength={40}
              pattern="[a-z0-9][a-z0-9-]*"
              disabled={!props.canAdmin}
            />
          )}
        </Field>
        {props.canAdmin ? (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={update.isPending}>
              {t("common.save")}
            </Button>
            {saved ? (
              <span role="status" className="text-sm text-success">
                {t("settings.saved")}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">{t("settings.readOnly")}</p>
        )}
      </form>
    </section>
  );
}

function MembersSection(props: { workspaceId: string; myId: string; myRole: Role }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const members = useQuery(membersQuery(props.workspaceId)).data ?? [];
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId] });
  const changeRole = useMutation({
    mutationFn: async (input: { userId: string; role: Role }) =>
      unwrap(
        await api.PATCH("/api/workspaces/{ws}/members/{user}", {
          params: { path: { ws: props.workspaceId, user: input.userId } },
          body: { role: input.role },
        }),
      ),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });
  const remove = useMutation({
    mutationFn: async (userId: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/members/{user}", {
        params: { path: { ws: props.workspaceId, user: userId } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
      return userId;
    },
    onSuccess: async (userId) => {
      setError(null);
      if (userId === props.myId) {
        await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        await navigate({ to: "/" });
      } else {
        void invalidate();
      }
    },
    onError: (err) => setError(message(err)),
  });
  const canAdmin = props.myRole !== "member";
  const canTouch = (member: Member) =>
    canAdmin &&
    member.user_id !== props.myId &&
    (props.myRole === "owner" || member.role !== "owner");
  return (
    <section aria-labelledby="members-heading" className="flex flex-col gap-3">
      <h2 id="members-heading" className="text-md font-semibold">
        {t("shell.home.members")}
      </h2>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-fg-muted">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("settings.memberName")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("auth.email")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("settings.role")}
              </th>
              <th scope="col" className="py-1 font-medium">
                <span className="sr-only">{t("settings.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.user_id} className="border-t border-border">
                <td className="py-2 pr-3">
                  {member.name} <span className="text-fg-muted">@{member.handle}</span>
                  {member.user_id === props.myId ? (
                    <Badge className="ml-2">{t("settings.you")}</Badge>
                  ) : null}
                </td>
                <td className="py-2 pr-3">{member.email}</td>
                <td className="py-2 pr-3">
                  {canTouch(member) ? (
                    <select
                      aria-label={t("settings.roleOf", { name: member.name })}
                      value={member.role}
                      onChange={(event) =>
                        changeRole.mutate({
                          userId: member.user_id,
                          role: event.target.value as Role,
                        })
                      }
                      className="h-8 rounded border border-border bg-surface px-2"
                    >
                      {ROLES.filter((role) => role !== "owner" || props.myRole === "owner").map(
                        (role) => (
                          <option key={role} value={role}>
                            {t(`home.role.${role}`)}
                          </option>
                        ),
                      )}
                    </select>
                  ) : (
                    <Badge>{t(`home.role.${member.role}`)}</Badge>
                  )}
                </td>
                <td className="py-2 text-right">
                  {canTouch(member) ? (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => remove.mutate(member.user_id)}
                      aria-label={t("settings.remove", { name: member.name })}
                    >
                      {t("settings.removeShort")}
                    </Button>
                  ) : member.user_id === props.myId ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => remove.mutate(member.user_id)}
                    >
                      {t("settings.leave")}
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

function InviteSection(props: { workspaceId: string; myRole: Role }) {
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: async (body: { email: string; role: Role }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/invites", {
          params: { path: { ws: props.workspaceId } },
          body,
        }),
      ),
    onSuccess: (created) => {
      setError(null);
      setLink(created.accept_url);
    },
    onError: (err) => setError(message(err)),
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    invite.mutate(
      {
        email: String(data.get("email") ?? "").trim(),
        role: String(data.get("role") ?? "member") as Role,
      },
      { onSuccess: () => form.reset() },
    );
  }
  return (
    <section aria-labelledby="invite-heading" className="flex max-w-lg flex-col gap-3">
      <h2 id="invite-heading" className="text-md font-semibold">
        {t("settings.invite")}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field id="invite-email" label={t("auth.email")} error={error}>
          {(control) => (
            <Input {...control} name="email" type="email" required autoComplete="off" />
          )}
        </Field>
        <Field id="invite-role" label={t("settings.role")}>
          {(control) => (
            <select
              {...control}
              name="role"
              defaultValue="member"
              className="h-8 w-full rounded border border-border bg-surface px-2"
            >
              {ROLES.filter((role) => role !== "owner" || props.myRole === "owner").map((role) => (
                <option key={role} value={role}>
                  {t(`home.role.${role}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={invite.isPending}>
          {t("settings.sendInvite")}
        </Button>
      </form>
      {link ? (
        <div className="rounded border border-warning p-3">
          <p className="text-sm">{t("settings.inviteLinkHint")}</p>
          <output className="mt-1 block break-all font-mono text-sm" data-testid="invite-link">
            {link}
          </output>
        </div>
      ) : null}
    </section>
  );
}

function AuditSection(props: { workspaceId: string }) {
  const rows = useQuery(auditQuery(props.workspaceId)).data ?? [];
  return (
    <section aria-labelledby="audit-heading" className="flex flex-col gap-3">
      <h2 id="audit-heading" className="text-md font-semibold">
        {t("settings.audit")}
      </h2>
      {rows.length === 0 ? (
        <EmptyState
          title={t("settings.auditEmpty")}
          hint={t("settings.auditEmptyHint")}
          className="py-6"
        />
      ) : (
        <ol
          aria-label={t("settings.audit")}
          className="flex flex-col divide-y divide-border text-sm"
        >
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <time dateTime={row.ts} className="w-40 shrink-0 font-mono text-fg-muted">
                {new Date(row.ts).toLocaleString()}
              </time>
              <code className="rounded bg-raised px-1">{row.action}</code>
              <span className="text-fg-muted">
                {row.target_type}
                {row.target_id ? ` ${row.target_id.slice(0, 8)}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
