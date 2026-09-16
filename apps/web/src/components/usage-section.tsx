import "@perch/ui/i18n/settings";
import { Button, Field, Input, type MessageKey, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { budgetsQuery, usageQuery } from "../lib/queries.ts";

/**
 * What the workspace's models have cost, and the ceilings on them (spec §10's Phase 4 line "usage
 * dashboard"; task 4.2).
 *
 * Both halves read the same ledger: the table is `usage_events` added up the way you ask for, and
 * a budget says where it stands against it. Bars rather than a canvas, because this has to be
 * readable at 390 px and by a screen reader — the numbers are in the table, and the drawing is
 * decoration.
 */

const GROUPS = ["model", "provider", "actor", "day"] as const;
type Group = (typeof GROUPS)[number];

const SUBJECTS = ["workspace", "user", "bot"] as const;
const PERIODS = ["day", "month", "total"] as const;

function money(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(4);
}

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

export function UsageSection(props: { workspaceId: string; canAdmin: boolean }) {
  const [group, setGroup] = useState<Group>("model");
  const usage = useQuery(usageQuery(props.workspaceId, group));
  const slices = usage.data?.slices ?? [];
  const most = Math.max(0.000001, ...slices.map((one) => one.cost_usd));

  return (
    <section aria-labelledby="usage-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="usage-heading" className="text-md font-semibold">
          {t("usage.title")}
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">{t("usage.hint")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm" data-testid="usage-total">
          {t("usage.total", { total: money(usage.data?.total_usd ?? 0) })}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">{t("usage.groupBy")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={group}
            data-testid="usage-group"
            onChange={(event) => setGroup(event.currentTarget.value as Group)}
          >
            {GROUPS.map((one) => (
              <option key={one} value={one}>
                {t(`usage.group.${one}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {slices.length === 0 ? (
        <p role="status" className="text-sm text-fg-subtle">
          {t("usage.empty")}
        </p>
      ) : (
        <>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls on
              its own has to be reachable by a keyboard as well as a thumb (axe:
              scrollable-region-focusable), and the table holds nothing focusable. It is
              deliberately unnamed: a second landmark called "Audit log" inside the one
              already called that is a violation of its own. */}
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <caption className="sr-only">{t("usage.title")}</caption>
              <thead>
                <tr className="border-border border-b text-left">
                  <th scope="col" className="p-2">
                    {t("usage.column.key")}
                  </th>
                  <th scope="col" className="p-2">
                    {t("usage.column.calls")}
                  </th>
                  <th scope="col" className="p-2">
                    {t("usage.column.tokens")}
                  </th>
                  <th scope="col" className="p-2">
                    {t("usage.column.cost")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* At most 200 slices come back, and a group with more than that is a filter. */}
                {slices.map((slice) => (
                  <tr key={slice.key} data-testid="usage-row" className="border-border border-b">
                    <td className="p-2">
                      <span className="flex items-center gap-2">
                        <span className="truncate">{slice.key}</span>
                        <span
                          aria-hidden="true"
                          className="h-2 rounded bg-accent"
                          style={{ width: `${Math.round((slice.cost_usd / most) * 60)}px` }}
                        />
                      </span>
                    </td>
                    <td className="p-2 text-fg-muted">{slice.calls}</td>
                    <td className="p-2 text-fg-muted">
                      {slice.input_tokens + slice.output_tokens}
                    </td>
                    <td className="p-2">${money(slice.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Budgets workspaceId={props.workspaceId} canAdmin={props.canAdmin} />
    </section>
  );
}

function Budgets(props: { workspaceId: string; canAdmin: boolean }) {
  const queryClient = useQueryClient();
  const budgets = useQuery(budgetsQuery(props.workspaceId));
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState<(typeof SUBJECTS)[number]>("workspace");

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "budgets"] });

  const save = useMutation({
    mutationFn: async (body: {
      subject_type: (typeof SUBJECTS)[number];
      subject_id?: string;
      limit_usd: number;
      period: (typeof PERIODS)[number];
    }) =>
      unwrap(
        await api.PUT("/api/workspaces/{ws}/budgets", {
          params: { path: { ws: props.workspaceId } },
          body,
        }),
      ),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(message(err)),
  });

  const remove = useMutation({
    // A 204 has no body, so this one checks the error rather than unwrapping a result.
    mutationFn: async (id: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/budgets/{id}", {
        params: { path: { ws: props.workspaceId, id } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
    },
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const limit = Number(data.get("limit") ?? 0);
    const id = String(data.get("who") ?? "").trim();
    const period = String(data.get("period") ?? "month") as (typeof PERIODS)[number];
    if (!Number.isFinite(limit) || limit < 0) return;
    save.mutate(
      {
        subject_type: subject,
        ...(subject === "workspace" ? {} : { subject_id: id }),
        limit_usd: limit,
        period,
      },
      { onSuccess: () => form.reset() },
    );
  }

  const rows = budgets.data?.budgets ?? [];
  return (
    <section aria-labelledby="budgets-heading" className="flex flex-col gap-2">
      <h3 id="budgets-heading" className="text-sm font-medium">
        {t("budgets.title")}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t("budgets.empty")}</p>
      ) : (
        // One row per subject, and a workspace has few subjects with ceilings on them.
        <ul className="flex flex-col gap-1" data-testid="budget-list">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {t(`budgets.subject.${row.subject_type}` as MessageKey)}
              </span>
              <span className="text-fg-muted">
                {t("budgets.spent", {
                  spent: money(row.spent_usd),
                  limit: money(row.limit_usd),
                })}
              </span>
              <span className={row.remaining_usd < 0 ? "text-danger" : "text-fg-muted"}>
                {row.remaining_usd < 0
                  ? t("budgets.over", { over: money(-row.remaining_usd) })
                  : t("budgets.left", { left: money(row.remaining_usd) })}
              </span>
              {props.canAdmin ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  aria-label={t("budgets.remove", {
                    subject: t(`budgets.subject.${row.subject_type}` as MessageKey),
                  })}
                  onClick={() => remove.mutate(row.id)}
                >
                  ×
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {props.canAdmin ? (
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">{t("budgets.subject")}</span>
            <select
              className="min-h-touch rounded border border-border bg-surface px-2 py-1"
              value={subject}
              onChange={(event) =>
                setSubject(event.currentTarget.value as (typeof SUBJECTS)[number])
              }
            >
              {SUBJECTS.map((one) => (
                <option key={one} value={one}>
                  {t(`budgets.subject.${one}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          {subject === "workspace" ? null : (
            <Field id="budget-who" label={t("budgets.who")}>
              {(control) => <Input {...control} name="who" autoComplete="off" />}
            </Field>
          )}
          <Field id="budget-limit" label={t("budgets.limit")} error={error}>
            {(control) => (
              <Input {...control} name="limit" type="number" min="0" step="1" required />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">{t("budgets.period")}</span>
            <select
              name="period"
              className="min-h-touch rounded border border-border bg-surface px-2 py-1"
              defaultValue="month"
            >
              {PERIODS.map((one) => (
                <option key={one} value={one}>
                  {t(`budgets.period.${one}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {t("budgets.set")}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
