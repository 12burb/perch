import "@perch/ui/i18n/work";
import { Button, t } from "@perch/ui";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useState } from "react";

/**
 * A work item's description, as the document §4 asks for (task 3.26).
 *
 * This module is loaded on its own, when a panel is opened — Tiptap and ProseMirror are a large
 * part of what Work mode weighs, and nobody looking at a board has asked for an editor yet
 * (ADR-0145). The plain text is saved beside the document, so a bot reading `description` over the
 * Bot API and a person reading it here see the same words.
 */

export type DescriptionProps = {
  /** What is stored: the Tiptap document, when there is one. */
  doc: unknown;
  /** The plain text, which is what a document-less item has. */
  text: string;
  saving: boolean;
  saved: boolean;
  onSave: (next: { doc: unknown; text: string }) => void;
};

export default function Description(props: DescriptionProps) {
  const [dirty, setDirty] = useState(false);
  const editor = useEditor({
    extensions: [StarterKit],
    content: (props.doc as object | null) ?? props.text,
    // React mounts this twice in development; letting Tiptap render on the effect rather than
    // during the first render is what its React integration asks for.
    immediatelyRender: false,
    onUpdate: () => setDirty(true),
    editorProps: {
      attributes: {
        // ProseMirror's contenteditable is a text box, and saying so is what makes it one to a
        // screen reader and to anything driving the page.
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("work.description"),
        class: "min-h-24 rounded border border-border bg-surface p-2 text-sm focus:outline-accent",
      },
    },
  });

  return (
    <section aria-label={t("work.description")} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t("work.description")}</h3>
      <p className="text-sm text-fg-subtle">{t("work.description.hint")}</p>
      <EditorContent editor={editor} />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={props.saving || !editor}
          onClick={() => {
            if (!editor) return;
            props.onSave({ doc: editor.getJSON(), text: editor.getText() });
            setDirty(false);
          }}
        >
          {props.saving ? t("work.description.saving") : t("work.description.save")}
        </Button>
        {props.saved && !dirty ? (
          <span role="status" className="text-sm text-fg-muted">
            {t("work.description.saved")}
          </span>
        ) : null}
      </div>
    </section>
  );
}
