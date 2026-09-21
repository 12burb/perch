/**
 * The transcript's feed (task 1.12): a replay from the api, then every seq the session's topic
 * announces, with a catch-up whenever a seq is missed. It is pure of React so the one thing it must
 * get right can be tested: when the pane switches sessions with a replay still in flight, the old
 * session's rows never land in the new one, and the new session's own replay is not skipped because
 * the old one was still running (ADR-0167).
 */
import type { TranscriptRecord } from "./transcript.ts";

export type FeedRow = TranscriptRecord;
/** The replay: every event after a seq, for one session. */
export type FetchRows = (sessionId: string, afterSeq: number) => Promise<FeedRow[]>;

export class TranscriptFeed {
  private sessionId = "";
  private records: TranscriptRecord[] = [];
  private lastSeq = 0;
  private inFlight: Promise<void> | null = null;
  /** Bumped on every switch; a replay that comes back under an older number is dropped. */
  private generation = 0;

  constructor(
    private readonly fetchRows: FetchRows,
    private readonly onChange: (records: TranscriptRecord[]) => void,
  ) {}

  /** The seq the feed has seen up to; a delta is appended only when it is the next one. */
  get seq(): number {
    return this.lastSeq;
  }

  /** A new session: nothing of the old one is kept, and whatever its replay still answers is dropped. */
  switchTo(sessionId: string): void {
    this.sessionId = sessionId;
    this.generation += 1;
    this.records = [];
    this.lastSeq = 0;
    this.inFlight = null;
    this.onChange(this.records);
  }

  /** Fetch what came after the last seq seen: one at a time, and a late answer for an old session lands nowhere. */
  catchUp(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const run = this.fetchRows(this.sessionId, this.lastSeq)
      .then((rows) => {
        if (generation !== this.generation) return;
        this.merge(rows);
      })
      .finally(() => {
        // Only this run's own mark: a newer session's replay may be in flight by now.
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  /** A streamed delta: appended when it is the next seq, otherwise a catch-up fills the gap. */
  delta(seq: number, delta: string): void {
    if (seq !== this.lastSeq + 1) {
      void this.catchUp();
      return;
    }
    this.lastSeq = seq;
    this.records = [...this.records, { seq, event: { type: "text", delta } }];
    this.onChange(this.records);
  }

  private merge(rows: FeedRow[]): void {
    const known = new Set(this.records.map((row) => row.seq));
    const fresh = rows.filter((row) => !known.has(row.seq));
    if (fresh.length === 0) return;
    this.records = [...this.records, ...fresh].sort((a, b) => a.seq - b.seq);
    this.lastSeq = this.records.at(-1)?.seq ?? this.lastSeq;
    this.onChange(this.records);
  }
}
