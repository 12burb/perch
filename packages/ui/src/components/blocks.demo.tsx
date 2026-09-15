import { useState } from "react";
import { type BlockAct, BlockRenderer, type ChatBlock } from "./blocks.tsx";

const START: ChatBlock[] = [
  { type: "text", text: "Deploy 1.4.2 to staging?" },
  { type: "approve_deny", id: "b-approve", text: "Ship it?", action: "deploy" },
  { type: "button", id: "b-button", text: "Run the tests", action: "test", style: "primary" },
  {
    type: "select",
    id: "b-select",
    text: "Which environment",
    action: "env",
    options: [
      { label: "Staging", value: "staging" },
      { label: "Production", value: "production" },
    ],
  },
  {
    type: "form",
    id: "b-form",
    text: "Tell the team",
    action: "note",
    fields: [
      { name: "title", label: "Title", kind: "text", required: true },
      { name: "body", label: "Notes", kind: "textarea" },
      {
        name: "urgency",
        label: "Urgency",
        kind: "select",
        options: [
          { label: "Whenever", value: "low" },
          { label: "Today", value: "high" },
        ],
      },
      { name: "notify", label: "Tell everyone", kind: "checkbox" },
    ],
  },
  { type: "progress", id: "b-progress", text: "Building", value: 0.42 },
];

/** The blocks as a bot posts them; acting answers in place, the way the api's reply would. */
export function BlocksDemo(props: { readOnly?: boolean }) {
  const [blocks, setBlocks] = useState<ChatBlock[]>(START);
  const [last, setLast] = useState("");

  const act = (input: BlockAct) => {
    setLast(`${input.blockId}:${JSON.stringify(input.values)}`);
    setBlocks((current) =>
      current.map((block) =>
        block.id === input.blockId
          ? {
              ...block,
              ...(block.type === "approve_deny"
                ? { decision: input.values.decision ?? "approved" }
                : {}),
              state: {
                byType: "user",
                byId: "8f2c0a3e-0000-4000-8000-000000000001",
                byName: "Ada",
                at: "2026-09-15T10:31:00.000Z",
                values: input.values,
              },
            }
          : block,
      ),
    );
  };

  return (
    <main className="flex flex-col gap-2 bg-canvas p-4 text-fg">
      <h1 className="text-lg font-semibold">Blocks</h1>
      {blocks.map((block) => (
        <BlockRenderer
          key={String(block.id ?? block.type)}
          block={block}
          {...(props.readOnly ? {} : { onAct: act })}
          fallback={(one) =>
            one.type === "text" ? <p className="text-md">{String(one.text ?? "")}</p> : null
          }
        />
      ))}
      <p data-testid="acted">{last}</p>
    </main>
  );
}
