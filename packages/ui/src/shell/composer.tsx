/**
 * The composer skeleton (spec §4 "One composer everywhere"): Markdown textarea that grows, a toolbar,
 * attach and send, persistent drafts, Enter sends, Shift+Enter newline, Esc cancels a running turn.
 * Mentions, slash commands, and the session-mode chips arrive with chat (Phase 2).
 */
import { Bold, Code, Italic, Paperclip, Send } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../components/primitives.tsx";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export type ComposerProps = {
  /** Where this composer lives; drafts persist per key. */
  draftKey: string;
  placeholder?: string;
  onSend: (text: string) => void | Promise<void>;
  /** Called on Esc while a turn is running. */
  onCancel?: () => void;
  onAttach?: (files: FileList) => void;
  running?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
};

const DRAFT_PREFIX = "perch.draft.";

function readDraft(key: string): string {
  try {
    return globalThis.localStorage?.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value) globalThis.localStorage?.setItem(DRAFT_PREFIX + key, value);
    else globalThis.localStorage?.removeItem(DRAFT_PREFIX + key);
  } catch {
    // storage unavailable: the draft lives in the textarea only
  }
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState(() => readDraft(props.draftKey));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    writeDraft(props.draftKey, text);
  }, [props.draftKey, text]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const send = useCallback(async () => {
    const value = text.trim();
    if (!value || props.disabled) return;
    setText("");
    await props.onSend(value);
  }, [text, props.disabled, props.onSend]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape" && props.running) {
      event.preventDefault();
      props.onCancel?.();
    }
  }

  function wrap(before: string, after = before) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = text.slice(start, end);
    const next = `${text.slice(0, start)}${before}${selected}${after}${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, end + before.length);
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={props.label ?? t("ui.composer")}
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border bg-surface p-2",
        props.className,
      )}
    >
      <div role="toolbar" aria-label={t("ui.formatting")} className="flex items-center gap-1">
        <IconButton label={t("ui.bold")} size="sm" onClick={() => wrap("**")}>
          <Bold className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton label={t("ui.italic")} size="sm" onClick={() => wrap("_")}>
          <Italic className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton label={t("ui.code")} size="sm" onClick={() => wrap("`")}>
          <Code className="size-4" aria-hidden="true" />
        </IconButton>
      </div>
      <textarea
        ref={textareaRef}
        id={`${id}-text`}
        aria-label={props.placeholder ?? t("ui.composerPlaceholder")}
        placeholder={props.placeholder ?? t("ui.composerPlaceholder")}
        value={text}
        rows={1}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-60 min-h-9 w-full resize-none bg-transparent px-1 py-1.5 font-sans text-md text-fg outline-none placeholder:text-fg-subtle"
      />
      <div className="flex items-center gap-1">
        {props.onAttach ? (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="sr-only"
              aria-label={t("ui.attach")}
              onChange={(event) => {
                if (event.target.files && event.target.files.length > 0)
                  props.onAttach?.(event.target.files);
                event.target.value = "";
              }}
            />
            <IconButton label={t("ui.attach")} size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip className="size-4" aria-hidden="true" />
            </IconButton>
          </>
        ) : null}
        <span className="ml-auto text-sm text-fg-subtle">{t("ui.composerHint")}</span>
        {props.running ? (
          <Button variant="danger" size="sm" onClick={props.onCancel}>
            {t("ui.cancelTurn")}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={props.disabled || text.trim().length === 0}
            aria-label={t("ui.send")}
          >
            <Send className="size-4" aria-hidden="true" />
            {t("ui.send")}
          </Button>
        )}
      </div>
    </form>
  );
}
