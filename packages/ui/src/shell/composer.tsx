/**
 * The composer skeleton (spec §4 "One composer everywhere"): Markdown textarea that grows, a toolbar,
 * attach and send, persistent drafts, Enter sends, Shift+Enter newline, Esc cancels a running turn.
 * Mentions are here (task 2.2): typing `@` or `#` at a word boundary asks `suggest` for the people,
 * bots and channels that match, and picking one writes the token the api understands. Slash commands
 * and the session-mode chips arrive with the rest of Phase 2.
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

/** One thing the composer can offer while somebody types a `@` or a `#`. */
export type Suggestion = {
  id: string;
  /** What the list shows. */
  label: string;
  /** A second line: a handle, a topic, whatever tells two of them apart. */
  hint?: string;
  /** What goes into the text in place of what was typed — `<@robin>`, `<#general>`. */
  insert: string;
};

export type MentionQuery = {
  /** Which key opened the list. */
  trigger: "@" | "#";
  /** What has been typed after it, lower case. */
  text: string;
};

export type ComposerProps = {
  /** Where this composer lives; drafts persist per key. */
  draftKey: string;
  placeholder?: string;
  /** A promise that rejects gives the text back to the box, so a refused message is not lost. */
  onSend: (text: string) => void | Promise<void>;
  /** Called on Esc while a turn is running. */
  onCancel?: () => void;
  onAttach?: (files: FileList) => void;
  running?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
  /** What to offer for a `@` or `#` being typed. Without it, nothing is suggested. */
  suggest?: (query: MentionQuery) => Suggestion[];
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

/**
 * The `@name` or `#name` the caret is inside, if any. A trigger only counts at the start of a word,
 * so an email address is not a mention and a fragment identifier is not a channel.
 */
export function mentionAt(
  text: string,
  caret: number,
): { start: number; query: MentionQuery } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s(])([@#])([a-z0-9._-]*)$/i.exec(before);
  if (!match) return null;
  const trigger = match[2] as "@" | "#";
  const typed = match[3] ?? "";
  return {
    start: caret - typed.length - 1,
    query: { trigger, text: typed.toLowerCase() },
  };
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState(() => readDraft(props.draftKey));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  /** What the caret is in the middle of typing, and which of the offers is highlighted. */
  const [mention, setMention] = useState<{ start: number; query: MentionQuery } | null>(null);
  const [active, setActive] = useState(0);
  const suggestions = mention && props.suggest ? props.suggest(mention.query).slice(0, 8) : [];
  const open = suggestions.length > 0;

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
    try {
      await props.onSend(value);
    } catch {
      // Refused (the owner says why): what was typed comes back, unless something new is there.
      setText((current) => (current === "" ? value : current));
    }
  }, [text, props.disabled, props.onSend]);

  /** Puts the token in place of what was typed, and leaves a space after it. */
  const accept = useCallback(
    (suggestion: Suggestion) => {
      if (!mention) return;
      const el = textareaRef.current;
      const caret = el ? el.selectionStart : text.length;
      const next = `${text.slice(0, mention.start)}${suggestion.insert} ${text.slice(caret)}`;
      const at = mention.start + suggestion.insert.length + 1;
      setText(next);
      setMention(null);
      setActive(0);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(at, at);
      });
    },
    [mention, text],
  );

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // While the list is open it takes the keys that drive a list, and nothing else changes.
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const chosen = suggestions[active] ?? suggestions[0];
        if (chosen) {
          event.preventDefault();
          accept(chosen);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
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
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
          setMention(
            props.suggest ? mentionAt(event.target.value, event.target.selectionStart) : null,
          );
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setMention(null)}
        // The textarea stays a textbox — it is one, and every caller finds it by that role. The
        // mention list is announced the way a comment box announces one: the active option is
        // named here, and the list itself is a listbox that comes and goes.
        aria-controls={`${id}-mentions`}
        {...(open && suggestions[active] ? { "aria-activedescendant": `${id}-m${active}` } : {})}
        className="max-h-60 min-h-9 w-full resize-none bg-transparent px-1 py-1.5 font-sans text-md text-fg outline-none placeholder:text-fg-subtle"
      />
      <div
        id={`${id}-mentions`}
        role="listbox"
        aria-label={t("ui.mentions")}
        hidden={!open}
        className="max-h-56 overflow-auto rounded-md border border-border bg-surface"
      >
        {suggestions.map((suggestion, index) => (
          <div
            key={suggestion.id}
            id={`${id}-m${index}`}
            role="option"
            // The caret never leaves the textarea: the active option is named from there, and this
            // is focusable only so that the option is a legal one.
            tabIndex={-1}
            aria-selected={index === active}
            className={cn(
              "flex cursor-pointer items-baseline gap-2 px-2 py-1 text-md",
              index === active && "bg-accent-soft text-accent",
            )}
            // The textarea keeps the focus, so the pick happens before the blur closes the list.
            onMouseDown={(event) => {
              event.preventDefault();
              accept(suggestion);
            }}
          >
            <span className="truncate">{suggestion.label}</span>
            {suggestion.hint ? (
              <span className="truncate text-sm text-fg-muted">{suggestion.hint}</span>
            ) : null}
          </div>
        ))}
      </div>
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
