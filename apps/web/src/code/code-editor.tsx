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
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

/**
 * The CodeMirror 6 editor (spec §5.1: ~40 languages loaded on demand, search/replace, multiple
 * selections). One EditorView per mounted file; the buffer flows up through onChange and Save
 * (⌘S / Ctrl-S) through onSave. Colors come from the shell's tokens so themes apply.
 */

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
});

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
};

export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;

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
