/**
 * A long list that only renders what you can see (spec §4 "every long list is virtualized"; the
 * check that keeps it true is `scripts/perf-budget.ts`, task 2.20).
 *
 * Perch had four virtualized lists before this and each one built its own scroller. This is that
 * scroller, once: a labelled `<ul>` whose rows are `<li>`s at measured offsets, so a screen reader
 * still hears a list and `aria-setsize` still says how long it really is.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useRef } from "react";
import { cn } from "../utils.ts";

export type VirtualListProps<T> = {
  rows: readonly T[];
  /** Stable per row: React's key and the virtualizer's, so a row keeps its place across updates. */
  keyOf: (row: T, index: number) => string;
  children: (row: T, index: number) => ReactNode;
  /** What a screen reader calls the list. */
  label: string;
  /** Roughly how tall a row is, before it is measured. */
  estimateSize?: number;
  /** Rows rendered above and below the window. */
  overscan?: number;
  /** On the scroll container. Give it a height, or a `min-h-0 flex-1` parent. */
  className?: string;
  /** On each row. */
  rowClassName?: string;
  "data-testid"?: string;
};

export function VirtualList<T>(props: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => props.estimateSize ?? 36,
    overscan: props.overscan ?? 12,
    getItemKey: (index) => {
      const row = props.rows[index];
      return row === undefined ? index : props.keyOf(row, index);
    },
  });
  return (
    <div
      ref={parentRef}
      className={cn("min-h-0 overflow-y-auto", props.className)}
      data-testid={props["data-testid"]}
    >
      <ul
        aria-label={props.label}
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = props.rows[item.index];
          if (row === undefined) return null;
          return (
            <li
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              // The list is the full length even though the DOM is not: a reader is told where it
              // is in all of it, not in the window.
              aria-setsize={props.rows.length}
              aria-posinset={item.index + 1}
              className={cn("absolute top-0 left-0 w-full", props.rowClassName)}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {props.children(row, item.index)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
