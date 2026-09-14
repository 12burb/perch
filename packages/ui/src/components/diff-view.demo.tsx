import { useState } from "react";
import { type DiffDecisionKind, type DiffFileView, DiffView } from "./diff-view.tsx";

/** Two files under review; a reject removes the hunk the way the app's refetch would. */
export function DiffViewDemo(props: { long?: boolean }) {
  const [files, setFiles] = useState<DiffFileView[]>(() => [
    {
      path: "notes.txt",
      status: "modified",
      additions: 3,
      deletions: 3,
      hunks: [
        {
          index: 0,
          header: "@@ -1,5 +1,5 @@",
          lines: [" line 1", "-line 2", "+line 2 (edited)", " line 3", " line 4", " line 5"],
        },
        {
          index: 1,
          header: "@@ -12,7 +12,7 @@",
          lines: [" line 12", " line 13", " line 14", "-line 15", "+line 15 (edited)", " line 16"],
        },
        {
          index: 2,
          header: "@@ -25,6 +25,6 @@",
          lines: [" line 25", " line 26", " line 27", "-line 28", "+line 28 (edited)", " line 29"],
        },
      ],
    },
    {
      path: "extra.txt",
      status: "added",
      additions: props.long ? 600 : 1,
      deletions: 0,
      hunks: [
        {
          index: 0,
          header: `@@ -0,0 +1,${props.long ? 600 : 1} @@`,
          lines: props.long ? Array.from({ length: 600 }, (_, i) => `+extra ${i + 1}`) : ["+extra"],
        },
      ],
    },
  ]);
  const [log, setLog] = useState<string[]>([]);
  const decide = (path: string, hunk: number, action: DiffDecisionKind) => {
    setLog((l) => [...l, `${path}#${hunk}:${action}`]);
    setFiles((current) =>
      current.map((file) =>
        file.path !== path
          ? file
          : {
              ...file,
              hunks:
                action === "reject"
                  ? file.hunks.filter((h) => h.index !== hunk)
                  : file.hunks.map((h) => (h.index === hunk ? { ...h, decision: action } : h)),
            },
      ),
    );
  };
  const decideFile = (path: string, action: DiffDecisionKind) => {
    setLog((l) => [...l, `${path}:*:${action}`]);
    setFiles((current) =>
      current.map((file) =>
        file.path !== path
          ? file
          : action === "reject"
            ? { ...file, hunks: [] }
            : {
                ...file,
                hunks: file.hunks.map((h) => ({ ...h, decision: h.decision ?? "accept" })),
              },
      ),
    );
  };
  return (
    <div className="flex h-[480px] flex-col">
      <DiffView
        files={files}
        onDecide={decide}
        onDecideFile={decideFile}
        onOpen={(path) => setLog((l) => [...l, `open:${path}`])}
      />
      <p data-testid="log" className="text-xs">
        {log.join(" ")}
      </p>
    </div>
  );
}
