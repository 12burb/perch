import "@perch/ui/i18n/work";
import { Badge, Button, t } from "@perch/ui";
import { VirtualList } from "@perch/ui/virtual-list";
import type { CycleRow, ModuleRow, WorkItemRow } from "../lib/queries.ts";

/**
 * The four layouts beside the board (spec §4 "main list/board/calendar/timeline/spreadsheet";
 * task 3.26).
 *
 * They are one file because they are one idea seen four ways: the same rows, sorted the way the
 * view says, drawn as a line, a month, a bar or a table. The list and the spreadsheet render a
 * window (ADR-0113) because a backlog has no ceiling; the calendar and the timeline are bounded by
 * what they are about — a month has thirty-one days, and a timeline draws the items with dates.
 *
 * Everything here works at 390 px: the table scrolls sideways inside its own box rather than
 * stretching the page, and the calendar falls to one column per week.
 */

export type ItemAction = (item: WorkItemRow) => void;

const PRIORITY = {
  1: "work.priority.1",
  2: "work.priority.2",
  3: "work.priority.3",
  4: "work.priority.4",
} as const;

function priorityOf(item: WorkItemRow): string | null {
  return item.priority in PRIORITY ? t(PRIORITY[item.priority as keyof typeof PRIORITY]) : null;
}

function dayOf(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

/** A row's identifier, as a button: every layout opens the same panel. */
function Open(props: { item: WorkItemRow; onOpen: ItemAction }) {
  return (
    <button
      type="button"
      className="font-mono text-sm text-fg-muted underline"
      onClick={() => props.onOpen(props.item)}
      aria-label={t("work.select", { identifier: props.item.identifier })}
    >
      {props.item.identifier}
    </button>
  );
}

/** The list: one line per item, the way somebody reads a backlog top to bottom. */
export function ListView(props: { items: WorkItemRow[]; onOpen: ItemAction }) {
  if (props.items.length === 0) return <Empty />;
  return (
    <VirtualList
      rows={props.items}
      label={t("work.layout.list")}
      keyOf={(item) => item.id}
      estimateSize={44}
      className="max-h-[70vh]"
    >
      {(item) => (
        <div
          data-testid="work-row"
          className="flex items-center gap-2 rounded border border-border px-2 py-1"
        >
          <Open item={item} onOpen={props.onOpen} />
          <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
          {priorityOf(item) ? (
            <Badge tone={item.priority === 1 ? "danger" : "neutral"}>{priorityOf(item)}</Badge>
          ) : null}
          <Badge>{t(`work.state.${item.state}`)}</Badge>
        </div>
      )}
    </VirtualList>
  );
}

const COLUMNS = ["state", "priority", "assignee", "cycle", "module", "estimate", "due"] as const;
type Column = (typeof COLUMNS)[number];

/**
 * The spreadsheet: the same rows with their properties beside them. Which columns is the view's
 * `display.properties`, so two people can look at the same items and see different things.
 */
export function SpreadsheetView(props: {
  items: WorkItemRow[];
  properties?: readonly string[] | undefined;
  cycles: CycleRow[];
  modules: ModuleRow[];
  onOpen: ItemAction;
}) {
  const shown = COLUMNS.filter(
    (column) => !props.properties?.length || props.properties.includes(column),
  );
  const cycleName = (id: string | null) =>
    props.cycles.find((one) => one.id === id)?.name ?? t("work.cycle.none");
  const moduleName = (id: string | null) =>
    props.modules.find((one) => one.id === id)?.name ?? t("work.module.none");
  const cell = (item: WorkItemRow, column: Column): string => {
    switch (column) {
      case "state":
        return t(`work.state.${item.state}`);
      case "priority":
        return priorityOf(item) ?? "—";
      case "assignee":
        return item.assignee_id ? (item.assignee_type ?? "—") : "—";
      case "cycle":
        return cycleName(item.cycle_id);
      case "module":
        return moduleName(item.module_id);
      case "estimate":
        return item.estimate === null ? "—" : String(item.estimate);
      case "due":
        return dayOf(item.due_at) ?? t("work.due.none");
    }
  };

  if (props.items.length === 0) return <Empty />;
  return (
    // The table scrolls inside its own box, so a wide sheet does not stretch a phone.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">{t("work.rows", { count: props.items.length })}</caption>
        <thead>
          <tr className="border-border border-b text-left">
            <th scope="col" className="p-2">
              {t("work.column.title")}
            </th>
            {shown.map((column) => (
              <th key={column} scope="col" className="p-2">
                {t(`work.column.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Capped by the query at 200 rows: past that the answer is a filter, not more rows. */}
          {props.items.map((item) => (
            <tr key={item.id} data-testid="work-cell-row" className="border-border border-b">
              <td className="p-2">
                <span className="flex items-center gap-2">
                  <Open item={item} onOpen={props.onOpen} />
                  <span className="truncate">{item.title}</span>
                </span>
              </td>
              {shown.map((column) => (
                <td key={column} className="p-2 text-fg-muted">
                  {cell(item, column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The days of the month a date falls in, starting on the first. */
function monthDays(anchor: Date): string[] {
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const days: string[] = [];
  for (let at = 0; at < 31; at += 1) {
    const day = new Date(first.getTime() + at * 86_400_000);
    if (day.getUTCMonth() !== first.getUTCMonth()) break;
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The calendar: a month of due dates. Items without one are not here — a calendar is a question
 * about when, and "no date" is not an answer to it.
 */
export function CalendarView(props: { items: WorkItemRow[]; onOpen: ItemAction }) {
  const dated = props.items.filter((item) => item.due_at);
  if (dated.length === 0) {
    return (
      <p role="status" className="text-sm text-fg-subtle">
        {t("work.calendar.none")}
      </p>
    );
  }
  const anchor = new Date(dated[0]?.due_at ?? new Date().toISOString());
  const byDay = new Map<string, WorkItemRow[]>();
  for (const item of dated) {
    const day = dayOf(item.due_at);
    if (!day) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  return (
    // One column on a phone, a week's worth on a desk: a month is bounded, so no window is needed.
    <ul
      aria-label={t("work.layout.calendar")}
      className="grid grid-cols-1 gap-2 sm:grid-cols-7"
      data-testid="work-calendar"
    >
      {monthDays(anchor).map((day) => (
        <li key={day} className="min-h-16 rounded border border-border p-2">
          <p className="text-sm text-fg-muted">{day.slice(8)}</p>
          <ul className="flex flex-col gap-1">
            {(byDay.get(day) ?? []).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="w-full truncate text-left text-sm underline"
                  onClick={() => props.onOpen(item)}
                  aria-label={t("work.select", { identifier: item.identifier })}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * The timeline: a bar per item, from when it was made to when it is due, against the span every
 * dated item covers. Items with no due date are left out for the calendar's reason.
 */
export function TimelineView(props: { items: WorkItemRow[]; onOpen: ItemAction }) {
  const dated = props.items.filter((item) => item.due_at);
  if (dated.length === 0) {
    return (
      <p role="status" className="text-sm text-fg-subtle">
        {t("work.timeline.none")}
      </p>
    );
  }
  const starts = dated.map((item) => new Date(item.created_at).getTime());
  const ends = dated.map((item) => new Date(item.due_at ?? item.created_at).getTime());
  const from = Math.min(...starts);
  const until = Math.max(...ends);
  const span = Math.max(1, until - from);
  return (
    <ul
      aria-label={t("work.layout.timeline")}
      className="flex flex-col gap-2"
      data-testid="work-timeline"
    >
      {dated.map((item) => {
        const begins = new Date(item.created_at).getTime();
        const finishes = new Date(item.due_at ?? item.created_at).getTime();
        const left = ((begins - from) / span) * 100;
        const width = Math.max(4, ((finishes - begins) / span) * 100);
        return (
          <li key={item.id} className="flex items-center gap-2">
            <Open item={item} onOpen={props.onOpen} />
            <span className="min-w-0 flex-1">
              <span className="relative block h-4 rounded bg-surface-2">
                <span
                  className="absolute inset-y-0 rounded bg-accent"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  // The bar is decoration; the dates beside it are what is read out.
                  aria-hidden="true"
                />
              </span>
            </span>
            <span className="text-sm text-fg-muted">{dayOf(item.due_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** What is waiting in intake, with the two buttons that empty it (spec §4). */
export function IntakeQueue(props: {
  items: WorkItemRow[];
  busy: boolean;
  onAccept: ItemAction;
  onDecline: ItemAction;
  onOpen: ItemAction;
}) {
  if (props.items.length === 0) {
    return (
      <p role="status" className="text-sm text-fg-subtle">
        {t("work.intake.empty")}
      </p>
    );
  }
  return (
    // Capped by the API at 200: a triage queue longer than that is a conversation, not a list.
    <ul aria-label={t("work.intake")} className="flex flex-col gap-2" data-testid="work-intake">
      {props.items.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
        >
          <Open item={item} onOpen={props.onOpen} />
          <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
          <Button size="sm" disabled={props.busy} onClick={() => props.onAccept(item)}>
            {t("work.intake.accept")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy}
            onClick={() => props.onDecline(item)}
          >
            {t("work.intake.decline")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Empty() {
  return (
    <p role="status" className="text-sm text-fg-subtle">
      {t("work.nothing")}
    </p>
  );
}
