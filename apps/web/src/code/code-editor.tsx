import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  WidgetType,
} from "@codemirror/view";
import { t } from "@perch/ui";
import { useEffect, useImperativeHandle, useRef } from "react";
import { claimCommandKey } from "./editor-focus.ts";

/**
 * The CodeMirror 6 editor (spec §5.1: ~40 languages loaded on demand, search/replace, multiple
 * selections). One EditorView per mounted file; the buffer flows up through onChange and Save
 * (⌘S / Ctrl-S) through onSave. Colors come from the shell's tokens so themes apply.
 *
 * ⌘K on a selection asks for an inline edit (task 1.14): the proposal replaces the selection in the
 * buffer and the diff shows in place — the new lines highlighted, the replaced ones struck through
 * above them — until the pane accepts it or puts the original back.
 */

/** Shows the inline diff for a proposal, or clears it. */
const setInlineDiff = StateEffect.define<{ from: number; to: number; removed: string } | null>();

const ADDED = "cm-perch-added";

/** The text a proposal replaced, above the new lines. */
class RemovedText extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  override eq(other: RemovedText): boolean {
    return other.text === this.text;
  }
  override toDOM(): HTMLElement {
    const node = document.createElement("div");
    node.className = "cm-perch-removed";
    node.setAttribute("data-testid", "inline-removed");
    node.setAttribute("aria-label", t("editor.inline.removed"));
    node.textContent = this.text;
    return node;
  }
}

const inlineDiff = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setInlineDiff)) continue;
      const spec = effect.value;
      if (!spec) {
        next = Decoration.none;
        continue;
      }
      const marks = [];
      if (spec.removed.length > 0) {
        marks.push(
          Decoration.widget({
            widget: new RemovedText(spec.removed),
            block: true,
            side: -1,
          }).range(tr.state.doc.lineAt(spec.from).from),
        );
      }
      if (spec.to > spec.from) {
        marks.push(Decoration.mark({ class: ADDED }).range(spec.from, spec.to));
      }
      next = Decoration.set(marks, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Where the proposal sits now, after any edits since it landed. */
function proposalRange(state: EditorState): { from: number; to: number } | null {
  const set = state.field(inlineDiff, false);
  if (!set) return null;
  let found: { from: number; to: number } | null = null;
  set.between(0, state.doc.length, (from, to, value) => {
    if (value.spec.class !== ADDED) return undefined;
    found = { from, to };
    return false;
  });
  return found;
}

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--color-surface)", color: "var(--color-fg)" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "13px" },
  ".cm-content": { caretColor: "var(--color-fg)" },
  ".cm-gutters": {
    backgroundColor: "var(--color-raised)",
    color: "var(--color-fg-subtle)",
    borderRight: "1px solid var(--color-border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--color-accent) 8%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-accent-soft)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 25%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--color-raised)", color: "var(--color-fg)" },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--color-warning) 35%, transparent)",
  },
  [`.${ADDED}`]: {
    backgroundColor: "color-mix(in oklab, var(--color-success) 22%, transparent)",
  },
  ".cm-perch-removed": {
    backgroundColor: "color-mix(in oklab, var(--color-danger) 14%, transparent)",
    color: "var(--color-danger)",
    textDecoration: "line-through",
    whiteSpace: "pre-wrap",
    padding: "0 4px",
  },
});

/** What the editor pane drives from outside: the selection, and the life of a proposal. */
export type CodeEditorHandle = {
  /** The selection, or null when it is empty. */
  selection(): { from: number; to: number; text: string } | null;
  /**
   * Puts the proposal in the buffer and shows the diff in place. With `expected`, the range must
   * still hold that text — the person may have typed while the agent was thinking — and the
   * proposal is refused (false) rather than dropped on the wrong lines.
   */
  propose(range: { from: number; to: number }, replacement: string, expected?: string): boolean;
  /** Keeps the proposal, or puts the replaced text back; either way the diff goes away. */
  resolve(action: "accept" | "reject"): void;
};

export type CodeEditorProps = {
  path: string;
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  /** A 1-based line to scroll to and select once. */
  revealLine?: number | null;
  onRevealed?: () => void;
  /** Accessible name of the editor region. */
  label: string;
  /** ⌘K on a non-empty selection (task 1.14); without it ⌘K stays the command palette. */
  onInlineEdit?: (selection: { from: number; to: number; text: string }) => void;
  ref?: React.Ref<CodeEditorHandle>;
};

export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;
  /** The text a pending proposal replaced; its range is read back from the document. */
  const replaced = useRef<string | null>(null);

  useImperativeHandle(
    props.ref,
    () => ({
      selection() {
        const current = view.current;
        if (!current) return null;
        const { from, to } = current.state.selection.main;
        if (from === to) return null;
        return { from, to, text: current.state.sliceDoc(from, to) };
      },
      propose(range, replacement, expected) {
        const current = view.current;
        if (!current) return false;
        if (range.to > current.state.doc.length) return false;
        const removed = current.state.sliceDoc(range.from, range.to);
        if (expected !== undefined && removed !== expected) return false;
        replaced.current = removed;
        current.dispatch({
          changes: { from: range.from, to: range.to, insert: replacement },
          effects: setInlineDiff.of({
            from: range.from,
            to: range.from + replacement.length,
            removed,
          }),
          selection: { anchor: range.from + replacement.length },
          scrollIntoView: true,
        });
        return true;
      },
      resolve(action) {
        const current = view.current;
        const removed = replaced.current;
        if (!current) return;
        const range = proposalRange(current.state);
        replaced.current = null;
        if (action === "reject" && range && removed !== null) {
          current.dispatch({
            changes: { from: range.from, to: range.to, insert: removed },
            effects: setInlineDiff.of(null),
          });
          return;
        }
        current.dispatch({ effects: setInlineDiff.of(null) });
      },
    }),
    [],
  );

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      inlineDiff,
      // ⌘K is the command palette everywhere except here, with a selection (spec §4). A DOM
      // handler rather than a keymap entry, because claiming the event is what tells the shell.
      EditorView.domEventHandlers({
        keydown: (event, current) => {
          if (
            event.key.toLowerCase() !== "k" ||
            !(event.metaKey || event.ctrlKey) ||
            event.shiftKey ||
            event.altKey
          ) {
            return false;
          }
          const { from, to } = current.state.selection.main;
          if (from === to || !latest.current.onInlineEdit) return false;
          claimCommandKey(event);
          event.preventDefault();
          latest.current.onInlineEdit({ from, to, text: current.state.sliceDoc(from, to) });
          return true;
        },
      }),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            latest.current.onSave();
            return true;
          },
        },
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      language.current.of([]),
      editable.current.of(EditorView.editable.of(!latest.current.readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) latest.current.onChange(update.state.doc.toString());
      }),
      EditorView.contentAttributes.of({ "aria-label": latest.current.label, role: "textbox" }),
      theme,
    ];
    const state = EditorState.create({ doc: latest.current.value, extensions });
    const created = new EditorView({ state, parent });
    view.current = created;

    const description = LanguageDescription.matchFilename(languages, props.path);
    if (description) {
      void description.load().then((support) => {
        if (view.current === created) {
          created.dispatch({ effects: language.current.reconfigure(support) });
        }
      });
    }
    return () => {
      created.destroy();
      if (view.current === created) view.current = null;
    };
    // A new path is a new document; later prop changes flow through the effects below.
  }, [props.path]);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const doc = current.state.doc.toString();
    if (doc !== props.value) {
      current.dispatch({ changes: { from: 0, to: doc.length, insert: props.value } });
    }
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!props.readOnly)),
    });
  }, [props.readOnly]);

  useEffect(() => {
    const current = view.current;
    const line = props.revealLine;
    if (!current || !line) return;
    const clamped = Math.min(Math.max(line, 1), current.state.doc.lines);
    const info = current.state.doc.line(clamped);
    current.dispatch({
      selection: { anchor: info.from, head: info.to },
      effects: EditorView.scrollIntoView(info.from, { y: "center" }),
    });
    current.focus();
    props.onRevealed?.();
  }, [props.revealLine, props.onRevealed]);

  return <div ref={host} className="h-full min-h-0" data-testid="code-editor" />;
}
