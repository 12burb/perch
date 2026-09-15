import "../i18n/code.ts";
import { useState } from "react";
import { EditorGroup, type EditorTab } from "./editor-group.tsx";

/** A stand-in for the web app's editor: two tabs, one dirty, a plain-text body per tab. */
export function EditorGroupDemo() {
  const [tabs, setTabs] = useState<EditorTab[]>([
    { id: "src/index.ts", title: "index.ts" },
    { id: "README.md", title: "README.md", dirty: true },
  ]);
  const [active, setActive] = useState<string | null>("src/index.ts");
  const current = tabs.find((tab) => tab.id === active);
  return (
    <div style={{ height: 320 }}>
      <EditorGroup
        tabs={tabs}
        activeId={active}
        onSelect={setActive}
        onClose={(id) => {
          const remaining = tabs.filter((tab) => tab.id !== id);
          setTabs(remaining);
          if (active === id) setActive(remaining[0]?.id ?? null);
        }}
        breadcrumbs={current?.id.split("/")}
      >
        <p className="p-3">body of {current?.title}</p>
      </EditorGroup>
    </div>
  );
}
