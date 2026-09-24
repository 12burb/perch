# @perch/jobs

The Postgres job queue on the `jobs` table (spec §2, §6): `FOR UPDATE SKIP LOCKED` claims, retries with
exponential backoff, cron via croner, a worker loop, and lock timeouts so a crashed worker's job is
reclaimed.

```ts
const queue = createQueue({ db });
await queue.enqueue({ queue: "email", payload: { to } });
await queue.schedule({ key: "telemetry.ping", queue: "system", cron: "0 3 * * *" });
const worker = queue.worker({ queues: ["email", "system"], handlers: { email: sendEmail, system: runSystem } });
worker.start();
```

Semantics: a claim bumps `attempts` and sets the lock; `complete` deletes the row (cron rows reschedule
to the next run instead); `fail` clears the lock, stores `last_error`, and moves `run_at` by the backoff
until `max_attempts`, after which a one-off row stays for inspection and is never claimed, while a cron
row starts over at its next occurrence with `last_error` kept. Scheduling a key again with the same
expression and zone keeps a `run_at` that is already due, so a run missed while the instance was off
happens when it comes back; a changed expression or zone moves it. A lock older than `lockTimeoutMs`
(default 60 s) counts as abandoned. An error from the queue itself (a claim, or recording an outcome)
goes to the worker's `onLoopError`, and the loop sleeps one poll interval and carries on.
