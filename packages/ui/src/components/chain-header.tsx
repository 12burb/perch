/**
 * ChainHeader (spec §4 component list, §5.4 "every hop audited"; task 2.7).
 *
 * When bots start tagging each other, a thread stops being a conversation and becomes a chain, and
 * the thing a person wants to know is simple: who is in it, how far it has gone, what it has cost,
 * and whether it is still running. That is the whole component.
 */
import "../i18n/chat.ts";
import { t } from "../i18n/index.ts";
import { Badge } from "./primitives.tsx";

export type ChainHop = {
  hop: number;
  fromName: string | null;
  toName: string | null;
  mode: "consult" | "handoff" | "fanout";
};

export type ChainHeaderProps = {
  hops: ChainHop[];
  costUsd: number;
  /** Paused, by a person or by the rails. */
  stopped: boolean;
  /** Why the rails stopped it, when they did. */
  breaker?: string | null;
};

/** Dollars, the way a header says them: cents when there are any, and "under a cent" when not. */
export function money(costUsd: number): string {
  if (costUsd <= 0) return "$0.00";
  if (costUsd < 0.01) return t("chain.tiny");
  return `$${costUsd.toFixed(2)}`;
}

export function ChainHeader(props: ChainHeaderProps) {
  if (props.hops.length === 0) return null;
  const names = [...new Set(props.hops.map((hop) => hop.toName).filter(Boolean))] as string[];
  return (
    <section
      aria-label={t("chain.heading")}
      data-testid="chain-header"
      className="flex flex-wrap items-center gap-2 rounded border border-border bg-raised px-2 py-1 text-sm"
    >
      <span className="font-medium">{t("chain.heading")}</span>
      <span className="text-fg-muted">
        {t("chain.hops", { count: props.hops.length })} · {money(props.costUsd)}
      </span>
      <span className="flex flex-wrap gap-1">
        {names.map((name) => (
          <Badge key={name} tone="bot">
            {name}
          </Badge>
        ))}
      </span>
      {props.stopped ? (
        <Badge tone="warning" data-testid="chain-stopped">
          {props.breaker ? t("chain.stoppedBecause", { why: props.breaker }) : t("chain.stopped")}
        </Badge>
      ) : null}
    </section>
  );
}
