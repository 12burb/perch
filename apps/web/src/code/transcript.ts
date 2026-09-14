/**
 * The transcript reducer (task 1.12): session_events records (a person's turns and the engine's
 * events, ADR-0074) become the items the SessionTranscript renders: consecutive text deltas of
 * one reply fold into one text item, a tool call and its result into one card, a permission and
 * its answer (from the bus) into one prompt. Pure, so the pane can re-run it on every change.
 */
import type { SessionEvent } from "@perch/events";
import type { PermissionAnswerKind, TranscriptItem } from "@perch/ui/session";

export type TranscriptRecord = { seq: number; event: SessionEvent };

export type TranscriptUsage = { input: number; output: number; costUsd: number };

export type Transcript = {
  items: TranscriptItem[];
  usage: TranscriptUsage;
  /** The permission still waiting for an answer, when one is. */
  pendingPermission: string | null;
};

export function reduceTranscript(
  records: TranscriptRecord[],
  answers: ReadonlyMap<string, PermissionAnswerKind> = new Map(),
  streaming = false,
): Transcript {
  const items: TranscriptItem[] = [];
  const usage: TranscriptUsage = { input: 0, output: 0, costUsd: 0 };
  let pendingPermission: string | null = null;
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  let text: Extract<TranscriptItem, { kind: "text" }> | null = null;
  const closeText = () => {
    if (text) text.streaming = false;
    text = null;
  };
  for (const { seq, event } of records) {
    switch (event.type) {
      case "turn":
        closeText();
        items.push({ kind: "turn", id: `t${seq}`, text: event.text, mode: event.mode });
        pendingPermission = null;
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
        const answer = answers.get(event.id);
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
