import "@perch/ui/i18n/settings";
import { Button, EmptyState, Field, Input, type MessageKey, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  type AuditFilters,
  auditParams,
  auditQuery,
  instanceSettingsQuery,
} from "../lib/queries.ts";

/**
 * Who did what and when (spec §6, §7.1; task 4.5).
 *
 * The audit log is the answer to a question somebody asks under pressure — after an incident, in a
 * review, when a bot did something nobody expected — so it is filterable by the three things
 * anybody actually knows at that moment (what kind of thing happened, who did it, and roughly
 * when) and exportable, because the next question is usually asked in a spreadsheet.
 */

const ACTOR_TYPES = ["user", "bot", "system", "runner"] as const;
/** The newest hundred; the filters are how you reach further back (registered in LIST_SURFACES). */
const LIMIT = 100;

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

export function AuditSection(props: { workspaceId: string }) {
  const [filters, setFilters] = useState<AuditFilters>({});
  const audit = useQuery(auditQuery(props.workspaceId, { ...filters, limit: LIMIT }));
  const rows = audit.data?.rows ?? [];
  const actions = audit.data?.actions ?? [];

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(auditParams(filters))) {
    if (key !== "limit") params.set(key, String(value));
  }
  const exportUrl = `/api/workspaces/${props.workspaceId}/audit/export?${params.toString()}`;

  const set = (patch: AuditFilters) => setFilters((before) => ({ ...before, ...patch }));

  return (
    <section aria-labelledby="audit-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="audit-heading" className="text-md font-semibold">
          {t("settings.audit")}
        </h2>
        <a
          className="min-h-touch rounded border border-border px-3 py-1.5 text-sm hover:bg-raised"
          href={exportUrl}
          download
          data-testid="audit-export"
        >
          {t("audit.export")}
        </a>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">{t("audit.action")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={filters.action ?? ""}
            data-testid="audit-action"
            onChange={(event) => set({ action: event.currentTarget.value || undefined })}
          >
            <option value="">{t("audit.any")}</option>
            {/* The actions this workspace has actually recorded, capped at 200 by the endpoint. */}
            {actions.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">{t("audit.actor")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={filters.actor_type ?? ""}
            data-testid="audit-actor"
            onChange={(event) =>
              set({
                actor_type:
                  (event.currentTarget.value as (typeof ACTOR_TYPES)[number]) || undefined,
              })
            }
          >
            <option value="">{t("audit.any")}</option>
            {ACTOR_TYPES.map((one) => (
              <option key={one} value={one}>
                {t(`audit.actor.${one}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <Field id="audit-from" label={t("audit.from")}>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={filters.from ?? ""}
              onChange={(event) => set({ from: event.currentTarget.value || undefined })}
            />
          )}
        </Field>
        <Field id="audit-to" label={t("audit.to")}>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={filters.to ?? ""}
              onChange={(event) => set({ to: event.currentTarget.value || undefined })}
            />
          )}
        </Field>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFilters({})}
          disabled={Object.values(filters).every((value) => !value)}
        >
          {t("audit.clear")}
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={t("settings.auditEmpty")}
          hint={t("settings.auditEmptyHint")}
          className="py-6"
        />
      ) : (
        <>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls on
              its own has to be reachable by a keyboard as well as a thumb (axe:
              scrollable-region-focusable), and the table holds nothing focusable. It is
              deliberately unnamed: a second landmark called "Audit log" inside the one
              already called that is a violation of its own. */}
          <div className="overflow-x-auto" tabIndex={0}>
            <table
              className="w-full min-w-[40rem] border-collapse text-sm"
              data-testid="audit-table"
            >
              <caption className="sr-only">{t("settings.audit")}</caption>
              <thead>
                <tr className="border-border border-b text-left">
                  <th scope="col" className="p-2">
                    {t("audit.when")}
                  </th>
                  <th scope="col" className="p-2">
                    {t("audit.actor")}
                  </th>
                  <th scope="col" className="p-2">
                    {t("audit.action")}
                  </th>
                  <th scope="col" className="p-2">
                    {t("audit.target")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* At most LIMIT rows: older ones are reached with the date filters. */}
                {rows.map((row) => (
                  <tr key={row.id} data-testid="audit-row" className="border-border border-b">
                    <td className="p-2 align-top">
                      <time dateTime={row.ts} className="font-mono text-fg-muted">
                        {new Date(row.ts).toLocaleString()}
                      </time>
                    </td>
                    <td className="p-2 align-top text-fg-muted">
                      {t(`audit.actor.${row.actor_type}` as MessageKey)}
                      {row.actor_id ? ` ${row.actor_id.slice(0, 8)}` : ""}
                    </td>
                    <td className="p-2 align-top">
                      <code className="rounded bg-raised px-1">{row.action}</code>
                    </td>
                    <td className="p-2 align-top text-fg-muted">
                      {row.target_type}
                      {row.target_id ? ` ${row.target_id.slice(0, 8)}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Retention />
    </section>
  );
}

/**
 * How long the log is kept, for whoever set this instance up. Anybody else is refused by the
 * endpoint and sees nothing here rather than a control that would not work.
 */
function Retention() {
  const queryClient = useQueryClient();
  const settings = useQuery(instanceSettingsQuery());
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (days: number) =>
      unwrap(await api.PATCH("/api/admin/settings", { body: { audit_retention_days: days } })),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["instance", "settings"] });
    },
    onError: (err) => setError(message(err)),
  });

  if (settings.isError || !settings.data) return null;
  const days = settings.data.audit_retention_days;

  return (
    <form
      className="flex flex-wrap items-end gap-2 border-border border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get("days") ?? 0);
        if (Number.isFinite(value) && value >= 0) save.mutate(Math.floor(value));
      }}
    >
      <Field id="audit-retention" label={t("audit.retention")} error={error}>
        {(control) => (
          <Input
            {...control}
            name="days"
            type="number"
            min="0"
            max="3650"
            defaultValue={String(days)}
            data-testid="audit-retention"
          />
        )}
      </Field>
      <Button type="submit" size="sm" disabled={save.isPending}>
        {t("audit.save")}
      </Button>
      <p className="text-sm text-fg-subtle" data-testid="audit-retention-hint">
        {days === 0 ? t("audit.forever") : t("audit.kept", { days: String(days) })}
      </p>
    </form>
  );
}
