/**
 * The transcript's feed (task 1.12): a replay from the api, then every seq the session's topic
 * announces, with a catch-up whenever a seq is missed. It is pure of React so the one thing it must
 * get right can be tested: when the pane switches sessions with a replay still in flight, the old
 * session's rows never land in the new one, and the new session's own replay is not skipped because
 * the old one was still running (ADR-0167).
 */
import type { TranscriptRecord } from "./transcript.ts";

export type FeedRow = TranscriptRecord;
/** One page of the replay, and the session's latest seq when the page was read. */
export type FeedPage = { rows: FeedRow[]; lastSeq: number };
/** The replay: one page of the events after a seq, for one session. */
export type FetchRows = (sessionId: string, afterSeq: number) => Promise<FeedPage>;

/** A catch-up on its way; `again` records an ask that came in while it ran. */
type Run = { again: boolean; done: Promise<void> };

export class TranscriptFeed {
  private sessionId = "";
  private records: TranscriptRecord[] = [];
  private lastSeq = 0;
  private inFlight: Run | null = null;
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

  /**
   * Fetch what came after the last seq seen, one run at a time, and a late answer for an old
   * session lands nowhere. A run reads page after page until it reaches the session's last seq
   * (a long transcript is more than one page). An ask that comes in while a run is on its way joins
   * it, and the run then reads once more from where it got to: the event that prompted the ask may
   * have been committed after the running read, and it would otherwise never be fetched.
   */
  catchUp(): Promise<void> {
    const running = this.inFlight;
    if (running) {
      running.again = true;
      return running.done;
    }
    const run: Run = { again: false, done: Promise.resolve() };
    run.done = this.drain(run, this.generation, this.sessionId).finally(() => {
      // Only this run's own mark: a newer session's replay may be in flight by now.
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run.done;
  }

  private async drain(run: Run, generation: number, sessionId: string): Promise<void> {
    for (;;) {
      const after = this.lastSeq;
      const page = await this.fetchRows(sessionId, after);
      if (generation !== this.generation) return;
      this.merge(page.rows);
      // Another page when this one moved the feed on and the session has more; a page that moved
      // nothing ends the run, so a server that answers oddly cannot spin it.
      if (this.lastSeq > after && this.lastSeq < page.lastSeq) continue;
      if (run.again) {
        run.again = false;
        continue;
      }
      return;
    }
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
