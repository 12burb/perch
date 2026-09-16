import "@perch/ui/i18n/work";
import { Badge, Button, Field, Input, type MessageKey, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, lazy, Suspense, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { type CycleRow, type ModuleRow, relationsQuery, type WorkItemRow } from "../lib/queries.ts";

/**
 * One work item, in the panel (spec §4 "panel work item properties + activity"; task 3.26).
 *
 * Properties are the row's own columns — state, priority, cycle, module, estimate, due — and each
 * one is a `PATCH` on its own, because a panel that only saves when you press a button loses what
 * you typed when a session moves the item under you.
 *
 * The description is the exception: it is a document, it is large, and it is loaded on demand.
 */

const Description = lazy(async () => await import("./description.tsx"));

const KINDS = ["blocks", "blocked_by", "relates", "duplicates"] as const;
type Kind = (typeof KINDS)[number];

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

function dayValue(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

export function ItemPanel(props: {
  item: WorkItemRow;
  workspaceId: string;
  projectId: string;
  cycles: CycleRow[];
  modules: ModuleRow[];
  states: readonly string[];
  /** `KEY-123` to the item it names, out of the rows this project has loaded. */
  resolve: (identifier: string) => WorkItemRow | undefined;
  onClose: () => void;
  onOpen: (item: WorkItemRow) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const related = useQuery(relationsQuery(props.item.id));

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["workspace", props.workspaceId, "work", props.projectId],
    });
    void queryClient.invalidateQueries({ queryKey: ["work-item", props.item.id, "relations"] });
  };

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      unwrap(
        await api.PATCH("/api/work-items/{id}", {
          params: { path: { id: props.item.id } },
          body: body as never,
        }),
      ),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      refresh();
    },
    onError: (err) => setError(message(err)),
  });

  const relate = useMutation({
    mutationFn: async (input: { related_id: string; kind: Kind }) =>
      unwrap(
        await api.POST("/api/work-items/{id}/relations", {
          params: { path: { id: props.item.id } },
          body: input,
        }),
      ),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(message(err)),
  });

  const unrelate = useMutation({
    mutationFn: async (input: { related: string; kind: Kind }) =>
      unwrap(
        await api.DELETE("/api/work-items/{id}/relations/{kind}/{related}", {
          params: { path: { id: props.item.id, kind: input.kind, related: input.related } },
        }),
      ),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(message(err)),
  });

  function onRelate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const typed = String(data.get("related") ?? "").trim();
    const kind = String(data.get("kind") ?? "relates") as Kind;
    if (!typed) return;
    // People say `KEY-123`, not a uuid. What this project has loaded is what can be named here.
    const other = props.resolve(typed);
    if (!other) {
      setError(t("work.relation.unknown", { identifier: typed }));
      return;
    }
    relate.mutate({ related_id: other.id, kind }, { onSuccess: () => form.reset() });
  }

  const item = props.item;
  return (
    <section
      aria-label={t("work.item")}
      data-testid="work-item-panel"
      className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-fg-muted">{item.identifier}</span>
        <Badge>{t(`work.type.${item.type}`)}</Badge>
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold">{item.title}</h2>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          {t("work.close")}
        </Button>
      </header>

      <section aria-label={t("work.properties")} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("work.properties")}</h3>

        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t("work.column.state")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={item.state}
            onChange={(event) => patch.mutate({ state: event.currentTarget.value })}
          >
            {props.states.map((state) => (
              <option key={state} value={state}>
                {t(`work.state.${state}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t("work.cycle")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={item.cycle_id ?? ""}
            onChange={(event) => patch.mutate({ cycle_id: event.currentTarget.value || null })}
          >
            <option value="">{t("work.cycle.none")}</option>
            {props.cycles.map((cycle) => (
              <option key={cycle.id} value={cycle.id}>
                {cycle.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t("work.module")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={item.module_id ?? ""}
            onChange={(event) => patch.mutate({ module_id: event.currentTarget.value || null })}
          >
            <option value="">{t("work.module.none")}</option>
            {props.modules.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t("work.estimate")}</span>
          <input
            type="number"
            min={0}
            max={1000}
            step={1}
            className="min-h-touch w-24 rounded border border-border bg-surface px-2 py-1"
            defaultValue={item.estimate ?? ""}
            onBlur={(event) => {
              const raw = event.currentTarget.value.trim();
              patch.mutate({ estimate: raw === "" ? null : Number(raw) });
            }}
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t("work.due")}</span>
          <input
            type="date"
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            defaultValue={dayValue(item.due_at)}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              patch.mutate({ due_at: raw ? new Date(`${raw}T12:00:00Z`).toISOString() : null });
            }}
          />
        </label>
      </section>

      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-subtle">
            {t("work.description.loading")}
          </p>
        }
      >
        <Description
          doc={item.description_doc}
          text={item.description}
          saving={patch.isPending}
          saved={saved}
          onSave={(next) => patch.mutate({ description: next.text, description_doc: next.doc })}
        />
      </Suspense>

      <section aria-label={t("work.subItems")} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("work.subItems")}</h3>
        {(related.data?.children ?? []).length === 0 ? (
          <p className="text-sm text-fg-subtle">{t("work.nothing")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {(related.data?.children ?? []).map((child) => (
              <li key={child.id} className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  className="font-mono text-fg-muted underline"
                  onClick={() => props.onOpen(child)}
                  aria-label={t("work.select", { identifier: child.identifier })}
                >
                  {child.identifier}
                </button>
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("work.relations")} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("work.relations")}</h3>
        <ul className="flex flex-col gap-1">
          {(related.data?.relations ?? []).map((one) => (
            <li key={`${one.kind}:${one.related_id}`} className="flex items-center gap-2 text-sm">
              <Badge>{t(`work.relation.${one.kind}`)}</Badge>
              {one.item ? (
                <button
                  type="button"
                  className="font-mono text-fg-muted underline"
                  onClick={() => one.item && props.onOpen(one.item)}
                  aria-label={t("work.select", { identifier: one.item.identifier })}
                >
                  {one.item.identifier}
                </button>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{one.item?.title ?? one.related_id}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={unrelate.isPending}
                aria-label={t("work.relation.remove", {
                  kind: t(`work.relation.${one.kind}`),
                  identifier: one.item?.identifier ?? one.related_id,
                })}
                onClick={() => unrelate.mutate({ related: one.related_id, kind: one.kind as Kind })}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
        <form onSubmit={onRelate} className="flex flex-wrap items-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">{t("work.relations")}</span>
            <select
              name="kind"
              className="min-h-touch rounded border border-border bg-surface px-2 py-1"
              defaultValue="relates"
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`work.relation.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <Field id="work-relate" label={t("work.relation.add")}>
            {(control) => <Input {...control} name="related" autoComplete="off" />}
          </Field>
          <Button type="submit" size="sm" disabled={relate.isPending}>
            {t("work.relation.save")}
          </Button>
        </form>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
