/**
 * The transcript reducer (task 1.12): session_events records (a person's turns and the engine's
 * events, ADR-0074) become the items the SessionTranscript renders: consecutive text deltas of
 * one reply fold into one text item, a tool call and its result into one card, a permission and
 * its answer (from the bus) into one prompt. Pure, so the pane can re-run it on every change.
 */
import type { SessionEvent } from "@perch/events";
import type { PermissionAnswerKind, SessionStatusKind, TranscriptItem } from "@perch/ui/session";

export type TranscriptRecord = { seq: number; event: SessionEvent };

export type TranscriptUsage = { input: number; output: number; costUsd: number };

export type Transcript = {
  items: TranscriptItem[];
  usage: TranscriptUsage;
  /** The permission still waiting for an answer, when one is. */
  pendingPermission: string | null;
};

/** Records after which a permission asked before them can no longer be waiting. */
const ROUND_ENDS = new Set<SessionEvent["type"]>(["done", "error", "turn", "restore"]);

/**
 * Which permission, if any, can still be answered. The api keeps one pending permission per
 * session and holds it only while the round runs, so it can only be the last one asked, and only
 * while the round it belongs to has not ended. An answer is not a session event: the ones this
 * pane saw live are in `answers`; every other permission a replay brings back was answered (or
 * dropped with its round) before the pane looked, and must not offer Allow / Deny again.
 * `status` is the session's as the pane knows it (undefined while it loads): needs_you says the
 * last permission is waiting; running (or not yet known) says so only while it is the very last
 * record, the moment between the permission landing and the status catching up.
 */
function livePermission(
  records: TranscriptRecord[],
  status: SessionStatusKind | undefined,
): string | null {
  let last = -1;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i]?.event.type === "permission") {
      last = i;
      break;
    }
  }
  const record = records[last];
  if (record?.event.type !== "permission") return null;
  const after = records.slice(last + 1);
  if (after.some((row) => ROUND_ENDS.has(row.event.type))) return null;
  if (status === "needs_you") return record.event.id;
  if ((status === "running" || status === undefined) && after.length === 0) {
    return record.event.id;
  }
  return null;
}

/**
 * Fold the records into the pane's items. `status` is the session's (it streams the last reply
 * while running, and decides which permission is still live).
 */
export function reduceTranscript(
  records: TranscriptRecord[],
  answers: ReadonlyMap<string, PermissionAnswerKind> = new Map(),
  status?: SessionStatusKind,
): Transcript {
  const streaming = status === "running";
  const live = livePermission(records, status);
  const items: TranscriptItem[] = [];
  const usage: TranscriptUsage = { input: 0, output: 0, costUsd: 0 };
  let pendingPermission: string | null = null;
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  let text: Extract<TranscriptItem, { kind: "text" }> | null = null;
  let turns = 0;
  const closeText = () => {
    if (text) text.streaming = false;
    text = null;
  };
  for (const { seq, event } of records) {
    switch (event.type) {
      case "turn":
        closeText();
        turns += 1;
        items.push({
          kind: "turn",
          id: `t${seq}`,
          text: event.text,
          mode: event.mode,
          turn: turns,
        });
        pendingPermission = null;
        break;
      case "restore":
        closeText();
        items.push({ kind: "restore", id: `s${seq}`, turn: event.turn });
        break;
      case "text":
        if (text) text.text += event.delta;
        else {
          text = { kind: "text", id: `x${seq}`, text: event.delta, streaming: true };
          items.push(text);
        }
        break;
      case "tool_call": {
        closeText();
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          id: `c${seq}`,
          name: event.name,
          args: event.args,
          status: "running",
        };
        tools.set(event.id, item);
        items.push(item);
        break;
      }
      case "tool_result": {
        closeText();
        const item = tools.get(event.id);
        if (item) {
          item.status = "done";
          if (event.output) item.output = event.output;
          if (event.diff) item.diff = event.diff;
          tools.delete(event.id);
        } else {
          items.push({
            kind: "tool",
            id: `r${seq}`,
            name: event.id,
            args: {},
            status: "done",
            output: event.output,
            ...(event.diff ? { diff: event.diff } : {}),
          });
        }
        break;
      }
      case "permission": {
        closeText();
        const answer = answers.get(event.id) ?? (event.id === live ? undefined : "answered");
        items.push({
          kind: "permission",
          id: event.id,
          tool: event.tool,
          args: event.args,
          ...(answer ? { answer } : {}),
        });
        pendingPermission = answer ? null : event.id;
        break;
      }
      case "usage":
        usage.input += event.input;
        usage.output += event.output;
        usage.costUsd += event.costUsd;
        break;
      case "done":
        closeText();
        pendingPermission = null;
        for (const item of tools.values()) item.status = "done";
        tools.clear();
        break;
      case "error":
        closeText();
        pendingPermission = null;
        for (const item of tools.values()) item.status = "error";
        tools.clear();
        items.push({ kind: "error", id: `e${seq}`, message: event.message });
        break;
      default:
        break;
    }
  }
  if (!streaming) closeText();
  return { items, usage, pendingPermission };
}
