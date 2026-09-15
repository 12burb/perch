/**
 * BlockRenderer (spec §4 component list, §5.2 "interactive blocks button, select, form (modal),
 * approve_deny, progress — interactions … update the block in place"; task 2.5).
 *
 * A message is blocks, and most of them are the app's own to draw: text carries mentions, a file
 * card needs the file it points at. Those come back through `fallback`. What lives here is the
 * half a bot asks a question with — the controls, what they look like once they have been
 * answered, and the one shape an answer is sent back in.
 *
 * A block answered is the block, still saying what it asked, plus who answered and with what. That
 * is the whole point of updating in place: the message carries its own outcome, so the person who
 * opens the channel tomorrow reads the same thing as the person who pressed the button.
 */
import "../i18n/chat.ts";
import { type ReactNode, useId, useState } from "react";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";
import { Badge, Button, Input, Label, Textarea } from "./primitives.tsx";

/** A block as the wire has it: the kind, and whatever that kind carries. */
export type ChatBlock = { type: string; [key: string]: unknown };

/** What was done to an interactive block, written into the block itself by the api. */
export type BlockAnswer = {
  byType: "user" | "bot";
  byId: string;
  byName?: string;
  at: string;
  values: Record<string, string>;
};

export type BlockAct = { blockId: string; values: Record<string, string> };

export type BlockOption = { label: string; value: string };
export type BlockField = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "select" | "checkbox";
  options?: BlockOption[];
  required?: boolean;
};

/** The kinds this renders itself. Everything else is the app's, and goes to `fallback`. */
export const INTERACTIVE_BLOCKS = ["button", "select", "form", "approve_deny"] as const;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionsOf(value: unknown): BlockOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    return [{ label: str(row.label) || str(row.value), value: str(row.value) }];
  });
}

function fieldsOf(value: unknown): BlockField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const kind = str(row.kind);
    return [
      {
        name: str(row.name),
        label: str(row.label) || str(row.name),
        kind:
          kind === "textarea" || kind === "select" || kind === "checkbox"
            ? (kind as BlockField["kind"])
            : "text",
        ...(row.options === undefined ? {} : { options: optionsOf(row.options) }),
        ...(row.required === true ? { required: true } : {}),
      },
    ];
  });
}

/** The answer written into the block, or null while the question is still open. */
export function answerOf(block: ChatBlock): BlockAnswer | null {
  const state = block.state;
  if (typeof state !== "object" || state === null) return null;
  const row = state as Record<string, unknown>;
  const values: Record<string, string> = {};
  if (typeof row.values === "object" && row.values !== null) {
    for (const [key, value] of Object.entries(row.values as Record<string, unknown>)) {
      values[key] = str(value);
    }
  }
  return {
    byType: row.byType === "bot" ? "bot" : "user",
    byId: str(row.byId),
    ...(str(row.byName) ? { byName: str(row.byName) } : {}),
    at: str(row.at),
    values,
  };
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Who answered, and when. The one line every answered block ends with. */
function Answered(props: { answer: BlockAnswer; detail?: string }) {
  const name = props.answer.byName ?? t("chat.someone");
  return (
    <p data-testid="block-answer" className="mt-1 text-sm text-fg-muted">
      {props.detail ? `${props.detail} · ` : ""}
      {t("block.answeredBy", { name, at: when(props.answer.at) })}
    </p>
  );
}

type Acting = {
  blockId: string;
  answer: BlockAnswer | null;
  pending: boolean;
  onAct: ((input: BlockAct) => void) | undefined;
};

/** Answered, still being sent, no id to answer, or nobody who may: all of them mean "look, don't touch". */
function locked(acting: Acting): boolean {
  return acting.answer !== null || acting.pending || !acting.onAct || acting.blockId === "";
}

function ButtonBlock(props: { block: ChatBlock; acting: Acting }) {
  const label = str(props.block.text) || t("block.send");
  const style = str(props.block.style);
  return (
    <div data-testid="block-button" className="mt-1">
      <Button
        variant={style === "primary" ? "primary" : style === "danger" ? "danger" : "secondary"}
        disabled={locked(props.acting)}
        onClick={() =>
          props.acting.onAct?.({
            blockId: props.acting.blockId,
            values: { value: str(props.block.value) || label },
          })
        }
      >
        {label}
      </Button>
      {props.acting.answer ? <Answered answer={props.acting.answer} /> : null}
    </div>
  );
}

function SelectBlock(props: { block: ChatBlock; acting: Acting }) {
  const id = useId();
  const options = optionsOf(props.block.options);
  const label = str(props.block.text) || t("block.choose");
  const answer = props.acting.answer;
  const [value, setValue] = useState(options[0]?.value ?? "");
  if (answer) {
    const chosen = options.find((option) => option.value === answer.values.value);
    return (
      <div data-testid="block-select" className="mt-1">
        <p className="text-md">{label}</p>
        <p className="font-medium" data-testid="block-chosen">
          {chosen?.label ?? answer.values.value ?? ""}
        </p>
        <Answered answer={answer} />
      </div>
    );
  }
  return (
    <div data-testid="block-select" className="mt-1 flex flex-wrap items-end gap-2">
      <div className="flex min-w-40 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <select
          id={id}
          value={value}
          disabled={locked(props.acting)}
          onChange={(event) => setValue(event.target.value)}
          className="h-8 rounded border border-border bg-surface px-2 text-md text-fg"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <Button
        variant="primary"
        disabled={locked(props.acting) || value === ""}
        onClick={() => props.acting.onAct?.({ blockId: props.acting.blockId, values: { value } })}
      >
        {t("block.send")}
      </Button>
    </div>
  );
}

function FormBlock(props: { block: ChatBlock; acting: Acting }) {
  const id = useId();
  const fields = fieldsOf(props.block.fields);
  const label = str(props.block.text) || t("block.form");
  const answer = props.acting.answer;
  const [values, setValues] = useState<Record<string, string>>({});
  const set = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  if (answer) {
    return (
      <div data-testid="block-form" className="mt-1 rounded border border-border bg-raised p-2">
        <p className="font-medium">{label}</p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-sm">
          {fields.map((field) => (
            <div key={field.name} className="contents">
              <dt className="text-fg-muted">{field.label}</dt>
              <dd data-testid="block-value">{answer.values[field.name] ?? ""}</dd>
            </div>
          ))}
        </dl>
        <Answered answer={answer} />
      </div>
    );
  }
  return (
    <form
      data-testid="block-form"
      aria-label={label}
      className="mt-1 flex flex-col gap-2 rounded border border-border bg-raised p-2"
      onSubmit={(event) => {
        event.preventDefault();
        const answers: Record<string, string> = {};
        for (const field of fields) {
          const value = values[field.name] ?? (field.kind === "select" ? firstValue(field) : "");
          if (value !== "") answers[field.name] = value;
        }
        props.acting.onAct?.({ blockId: props.acting.blockId, values: answers });
      }}
    >
      <p className="font-medium">{label}</p>
      {fields.map((field) => {
        const fieldId = `${id}-${field.name}`;
        const value = values[field.name] ?? "";
        if (field.kind === "checkbox") {
          return (
            <div key={field.name} className="flex items-center gap-2">
              <input
                id={fieldId}
                type="checkbox"
                name={field.name}
                required={field.required === true}
                checked={value === "true"}
                disabled={locked(props.acting)}
                onChange={(event) => set(field.name, event.target.checked ? "true" : "")}
                className="size-4 rounded border-border"
              />
              <Label htmlFor={fieldId}>{field.label}</Label>
            </div>
          );
        }
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <Label htmlFor={fieldId}>
              {field.label}
              {field.required === true ? (
                <span className="text-fg-muted"> · {t("block.required")}</span>
              ) : null}
            </Label>
            {field.kind === "textarea" ? (
              <Textarea
                id={fieldId}
                name={field.name}
                required={field.required === true}
                value={value}
                disabled={locked(props.acting)}
                onChange={(event) => set(field.name, event.target.value)}
              />
            ) : field.kind === "select" ? (
              <select
                id={fieldId}
                name={field.name}
                required={field.required === true}
                value={value === "" ? firstValue(field) : value}
                disabled={locked(props.acting)}
                onChange={(event) => set(field.name, event.target.value)}
                className="h-8 rounded border border-border bg-surface px-2 text-md text-fg"
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={fieldId}
                name={field.name}
                required={field.required === true}
                value={value}
                disabled={locked(props.acting)}
                onChange={(event) => set(field.name, event.target.value)}
              />
            )}
          </div>
        );
      })}
      <div>
        <Button type="submit" variant="primary" disabled={locked(props.acting)}>
          {t("block.submit")}
        </Button>
      </div>
    </form>
  );
}

function firstValue(field: BlockField): string {
  return field.options?.[0]?.value ?? "";
}

function ApproveDenyBlock(props: { block: ChatBlock; acting: Acting }) {
  const label = str(props.block.text);
  const answer = props.acting.answer;
  const decision = answer ? (answer.values.decision ?? str(props.block.decision)) : "";
  return (
    <div data-testid="block-approve" className="mt-1 flex flex-wrap items-center gap-2">
      <p className="text-md">{label}</p>
      {answer ? (
        <>
          <Badge tone={decision === "denied" ? "danger" : "accent"}>
            {decision === "denied" ? t("block.denied") : t("block.approved")}
          </Badge>
          <Answered answer={answer} />
        </>
      ) : (
        <>
          <Button
            variant="primary"
            disabled={locked(props.acting)}
            onClick={() =>
              props.acting.onAct?.({
                blockId: props.acting.blockId,
                values: { decision: "approved" },
              })
            }
          >
            {t("block.approve")}
          </Button>
          <Button
            variant="danger"
            disabled={locked(props.acting)}
            onClick={() =>
              props.acting.onAct?.({
                blockId: props.acting.blockId,
                values: { decision: "denied" },
              })
            }
          >
            {t("block.deny")}
          </Button>
        </>
      )}
    </div>
  );
}

/** Not a question: the bot moves it, so it is read, never pressed. */
function ProgressBlock(props: { block: ChatBlock }) {
  const raw = typeof props.block.value === "number" ? props.block.value : 0;
  const fraction = Math.min(Math.max(raw, 0), 1);
  const percent = Math.round(fraction * 100);
  const label = str(props.block.text) || t("block.progress", { percent });
  return (
    <div data-testid="block-progress" className="mt-1 flex flex-col gap-1">
      <p className="text-sm text-fg-muted">{label}</p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-full max-w-64 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={cn("h-full rounded-full bg-accent transition-[width]")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export type BlockRendererProps = {
  block: ChatBlock;
  /**
   * What to do with an answer. Left out when nobody here may act — a reader, an archived channel —
   * and the controls show as they are, refusing the press rather than pretending it went nowhere.
   */
  onAct?: ((input: BlockAct) => void) | undefined;
  /** An answer already on its way: the controls hold still until it lands. */
  pending?: boolean | undefined;
  /** The blocks the app draws itself: text with its mentions, files, the cards a session sends. */
  fallback?: ((block: ChatBlock) => ReactNode) | undefined;
};

export function BlockRenderer(props: BlockRendererProps): ReactNode {
  const { block } = props;
  const acting: Acting = {
    blockId: str(block.id),
    answer: answerOf(block),
    pending: props.pending === true,
    onAct: props.onAct,
  };
  switch (block.type) {
    case "button":
      return <ButtonBlock block={block} acting={acting} />;
    case "select":
      return <SelectBlock block={block} acting={acting} />;
    case "form":
      return <FormBlock block={block} acting={acting} />;
    case "approve_deny":
      return <ApproveDenyBlock block={block} acting={acting} />;
    case "progress":
      return <ProgressBlock block={block} />;
    default:
      return props.fallback ? props.fallback(block) : null;
  }
}
