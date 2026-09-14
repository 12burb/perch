/** UUID v7 for every primary key (spec §6, ADR-0025): time-ordered, generated in the application. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
