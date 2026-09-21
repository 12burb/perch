/**
 * What each background session was last woken about, so one wait is one notification (task
 * 3.16) — and no more than this many sessions' worth of it, so a process that has run for months
 * holds no more than a process that has run for a day (ADR-0168). Past the limit the session
 * whose entry is oldest is forgotten; a session that changes state again moves to the young end.
 */
export const WAKE_MEMORY_LIMIT = 10_000;

export class WakeMemory {
  private readonly last = new Map<string, string>();

  constructor(private readonly limit = WAKE_MEMORY_LIMIT) {}

  /** True when this state is news for the session, which is then remembered; false when it was the last one already. */
  note(sessionId: string, state: string): boolean {
    if (this.last.get(sessionId) === state) return false;
    this.last.delete(sessionId);
    this.last.set(sessionId, state);
    while (this.last.size > this.limit) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.last.size;
  }
}
