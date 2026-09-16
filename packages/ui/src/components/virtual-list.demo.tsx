import { VirtualList } from "./virtual-list.tsx";

const ROWS = Array.from({ length: 2_000 }, (_, at) => ({ id: `row-${at}`, label: `Row ${at}` }));

/** Two thousand rows in a 300 px window: what the component test counts. */
export function VirtualListDemo() {
  return (
    <VirtualList
      rows={ROWS}
      label="Rows"
      keyOf={(row) => row.id}
      estimateSize={24}
      overscan={4}
      className="h-[300px]"
      data-testid="rows"
    >
      {(row) => (
        <button type="button" data-testid="row" className="w-full text-left">
          {row.label}
        </button>
      )}
    </VirtualList>
  );
}
