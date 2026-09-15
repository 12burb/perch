# A project's environment

Variables a project's work runs with: the database it talks to in development, the keys its dev
server needs, the flags it is built under (spec §5.7). They are encrypted at rest, put in front of
the processes that need them, and kept out of everything that gets written down.

## Write-only

A value goes in once and never comes back out. `GET .../env` answers with the keys, where each one
came from and when it was last set — never a value — and there is no route that returns one. Each
value is sealed by the vault under its own project and key, so a row lifted out of the database will
not open anywhere, and a ciphertext moved to another row will not open either.

```
GET /api/workspaces/{ws}/projects/{p}/env
    → { vars: [{ key, source, updated_at }] }
PUT /api/workspaces/{ws}/projects/{p}/env
    { vars: [{ key, value, source? }], remove?: ["OLD_KEY"] }
```

`source` says where a variable came from: typed here (`manual`), or imported from Vercel, Supabase
or a vault backend, which arrive with connections v2.

## Where it is injected

| Where | How |
|---|---|
| Sessions | `session.create` carries the project's environment; the model profile's own credential is layered on top, so a project variable cannot stand in for a provider key |
| Terminals | `pty.open` carries it, so anything started in a shell — a dev server, a migration, a test run — has it |
| Previews | the dev server runs in a terminal, so it has it already |

`PERCH_*` names are never taken from a project: they configure Perch's own processes and carry its
connect token, master key and session secret.

## Never into a transcript

A session runs with the real values, and the record of that session does not contain them. Every
event is read on its way to `session_events` and any value the project's environment holds is
replaced by `[redacted: NAME]` — in text, in a tool's arguments, in its output, however deep it sits.
So an agent that prints `$DATABASE_URL` says so in a way anybody can read without learning anything,
and the transcript that is replayed to a model later carries the name rather than the value.

Values shorter than six characters are left alone: redacting every `on` in a transcript would help
nobody.
