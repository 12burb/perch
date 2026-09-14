import { useState } from "react";
import {
  type PermissionAnswerKind,
  SessionTranscript,
  type TranscriptItem,
} from "./session-transcript.tsx";

/** A transcript with every kind of item, for the component test. */
export function SessionTranscriptDemo() {
  const [items, setItems] = useState<TranscriptItem[]>([
    { kind: "turn", id: "1", text: "Add a notes file", mode: "build" },
    { kind: "text", id: "2", text: "Reading the project" },
    {
      kind: "tool",
      id: "3",
      name: "Read README.md",
      args: { path: "README.md" },
      status: "done",
      output: "# Project",
    },
    {
      kind: "tool",
      id: "4",
      name: "Edit notes.txt",
      args: { path: "notes.txt" },
      status: "done",
      output: "wrote notes.txt",
      diff: [
        {
          path: "notes.txt",
          patch: "--- /dev/null\n+++ b/notes.txt\n@@ -1,0 +1,1 @@\n+hello\n",
          additions: 1,
          deletions: 0,
          status: "added",
        },
      ],
    },
    { kind: "permission", id: "p1", tool: "Edit notes.txt", args: { path: "notes.txt" } },
  ]);
  const [answered, setAnswered] = useState<string | null>(null);
  const onPermission = (id: string, answer: PermissionAnswerKind) => {
    setAnswered(`${id}:${answer}`);
    setItems((current) =>
      current.map((item) =>
        item.kind === "permission" && item.id === id ? { ...item, answer } : item,
      ),
    );
  };
  return (
    <div className="flex h-[480px] flex-col">
      <SessionTranscript items={items} status="needs_you" onPermission={onPermission} />
      <p data-testid="answered">{answered ?? "none"}</p>
      <button
        type="button"
        onClick={() =>
          setItems((current) => [
            ...current,
            ...Array.from({ length: 300 }, (_, i) => ({
              kind: "text" as const,
              id: `bulk-${i}`,
              text: `line ${i}`,
            })),
          ])
        }
      >
        Add many
      </button>
    </div>
  );
}
