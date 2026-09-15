/**
 * InboxList (spec §4 component list, §5.7 "one queue for permission prompts, preflight results, PRs
 * awaiting review, budget alerts, failed bot runs, chain breakers, intake, mentions … batch
 * approve, snooze, delegate"; task 2.10).
 *
 * One row is one thing waiting for one person: what it is, what it says, and the two or three
 * things that can be done about it. Choosing several and acting on them all at once is the point of
 * a queue, so the list owns the choosing and hands the caller the ids.
 */
import "../i18n/inbox.ts";
import { useId, useState } from "react";
import { t } from "../i18n/index.ts";
import { EmptyState } from "../shell/empty-state.tsx";
import { Badge, Button } from "./primitives.tsx";

export type InboxKind =
  | "permission"
  | "preflight"
  | "pr"
  | "budget"
  | "bot_failure"
  | "chain"
  | "intake"
  | "mention";

export type InboxRow = {
  id: string;
  kind: InboxKind;
  title: string;
  body: string;
  /** Where to go to deal with it, when there is somewhere. */
  url: string | null;
  status: "open" | "snoozed" | "resolved";
  snoozedUntil: string | null;
  createdAt: string;
};

export type InboxListProps = {
  rows: InboxRow[];
  /** Opening one: the caller decides whether that is a link, a route, or a peek. */
  onOpen?: ((row: InboxRow) => void) | undefined;
  onResolve?: ((ids: string[]) => void) | undefined;
  onSnooze?: ((ids: string[]) => void) | undefined;
  /**
   * Answering the permissions an agent is waiting on, without going to the session (spec §5.7
   * "batch approve"). Only rows of kind `permission` are ever passed.
   */
  onAnswer?: ((ids: string[], answer: "allow" | "deny") => void) | undefined;
  /** What is happening right now, so the rows that are moving hold still. */
  busy?: boolean;
};

const TONE: Record<InboxKind, "accent" | "warning" | "danger" | undefined> = {
  permission: "accent",
  preflight: undefined,
  pr: undefined,
  budget: "warning",
  bot_failure: "danger",
  chain: "warning",
  intake: undefined,
  mention: undefined,
};

export function InboxList(props: InboxListProps) {
  const id = useId();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const here = props.rows.map((row) => row.id);
  const picked = chosen.filter((one) => here.includes(one));
  const allHere = here.length > 0 && picked.length === here.length;

  const toggle = (rowId: string, on: boolean) =>
    setChosen((current) =>
      on ? [...new Set([...current, rowId])] : current.filter((one) => one !== rowId),
    );

  const act = (run: ((ids: string[]) => void) | undefined, ids: string[]) => {
    if (!run || ids.length === 0) return;
    run(ids);
    setChosen((current) => current.filter((one) => !ids.includes(one)));
  };

  const answer = (ids: string[], decision: "allow" | "deny") => {
    if (!props.onAnswer || ids.length === 0) return;
    props.onAnswer(ids, decision);
    setChosen((current) => current.filter((one) => !ids.includes(one)));
  };

  /** The chosen rows an agent is actually waiting on: the only ones there is anything to answer. */
  const waiting = picked.filter(
    (one) => props.rows.find((row) => row.id === one)?.kind === "permission",
  );

  if (props.rows.length === 0) {
    return (
      <div data-testid="inbox">
        <EmptyState title={t("inbox.empty")} hint={t("inbox.emptyHint")} />
      </div>
    );
  }

  return (
    <section aria-label={t("inbox.heading")} data-testid="inbox" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <input
          id={`${id}-all`}
          type="checkbox"
          checked={allHere}
          onChange={(event) => setChosen(event.target.checked ? here : [])}
        />
        <label htmlFor={`${id}-all`} className="text-sm text-fg-muted">
          {t("inbox.selectAll")}
        </label>
        <span className="text-sm text-fg-muted" data-testid="inbox-chosen">
          {t("inbox.chosen", { count: picked.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {props.onAnswer && waiting.length > 0 ? (
            <Button
              size="sm"
              variant="primary"
              disabled={props.busy}
              onClick={() => answer(waiting, "allow")}
            >
              {t("inbox.approveChosen", { count: waiting.length })}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={props.onAnswer && waiting.length > 0 ? "secondary" : "primary"}
            disabled={picked.length === 0 || props.busy}
            onClick={() => act(props.onResolve, picked)}
          >
            {t("inbox.resolveChosen", { count: picked.length })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={picked.length === 0 || props.busy}
            onClick={() => act(props.onSnooze, picked)}
          >
            {t("inbox.snoozeChosen", { count: picked.length })}
          </Button>
        </div>
      </div>

      <ul aria-label={t("inbox.heading")} className="flex flex-col gap-1 px-1">
        {props.rows.map((row) => (
          <li
            key={row.id}
            data-testid="inbox-item"
            data-kind={row.kind}
            className="flex flex-wrap items-start gap-2 rounded border border-border bg-raised p-2"
          >
            <input
              id={`${id}-${row.id}`}
              type="checkbox"
              className="mt-1"
              checked={picked.includes(row.id)}
              aria-label={t("inbox.selectOne", { title: row.title })}
              onChange={(event) => toggle(row.id, event.target.checked)}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge {...(TONE[row.kind] ? { tone: TONE[row.kind] } : {})}>
                  {t(`inbox.kind.${row.kind}` as "inbox.kind.permission")}
                </Badge>
                <label htmlFor={`${id}-${row.id}`} className="min-w-0 truncate font-medium">
                  {row.title}
                </label>
              </div>
              <p className="text-sm break-words text-fg-muted">{row.body}</p>
              {row.status === "snoozed" && row.snoozedUntil ? (
                <p className="text-sm text-fg-subtle">
                  {t("inbox.snoozedUntil", { when: new Date(row.snoozedUntil).toLocaleString() })}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {props.onOpen && row.url ? (
                <Button size="sm" variant="ghost" onClick={() => props.onOpen?.(row)}>
                  {t("inbox.open_")}
                </Button>
              ) : null}
              {props.onAnswer && row.kind === "permission" ? (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={props.busy}
                    onClick={() => answer([row.id], "allow")}
                  >
                    {t("inbox.approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() => answer([row.id], "deny")}
                  >
                    {t("inbox.deny")}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => act(props.onResolve, [row.id])}
                >
                  {t("inbox.resolve")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy}
                onClick={() => act(props.onSnooze, [row.id])}
              >
                {t("inbox.snooze")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
