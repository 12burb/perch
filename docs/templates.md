# Templates and the demo workspace

A starter stack is a handful of files and the command that runs them. Perch writes them into a new
project and the Preview tab starts the command, so "new project" can be something that answers on a
port rather than an empty directory (task 4.8, spec §10's Phase 4 line).

## The stacks

| id | What it is | Port | Starts with |
|---|---|---|---|
| `bun-api` | An HTTP API on Bun, with a page, a health route and one endpoint. No dependencies. | 3000 | `bun --hot src/index.ts` |
| `next-app` | Next.js with the App Router and one page. | 3000 | `npm run dev` (after `npm install`) |
| `python-api` | FastAPI on uv, with a health route and one endpoint. | 8000 | `uv run uvicorn main:app --reload --port 8000` |
| `static-site` | One HTML page, one stylesheet, and a Bun server to hand them out. | 8080 | `bun serve.ts` |

They live in `templates/src/stacks.ts` as TypeScript — typechecked with everything else, in the
binary you downloaded, with no packaging step between this repository and your project. Every
dependency in them is pinned exactly, and a test asserts it.

```http
GET /api/templates
{"templates": [{"id": "bun-api", "name": "Bun API", "description": "…", "tags": ["bun", …],
                "port": 3000, "dev": "bun --hot src/index.ts", "files": 5}, …]}
```

Every stack ships a `.perch/project.json`, so the project arrives knowing its own run commands and
its own preview:

```json
{
  "run": { "dev": "bun --hot src/index.ts" },
  "preview": { "command": "bun --hot src/index.ts", "port": 3000, "path": "/" }
}
```

## Making a project from one

From Code mode — "New project" → "Start from a template" → pick one → Create — or:

```http
POST /api/workspaces/{ws}/projects/template
{"name": "Birdsong", "template": "bun-api", "default_branch": "main"}
```

The project is set up the way an empty one is (`git init` on a runner), the stack's files are
written into it, and Perch re-reads the `.perch/project.json` they brought. `source` on the row is
`template`. A template id nobody has is a 422 before any row is written.

## Starting the dev server

The Preview tab's Start button, or:

```http
POST /api/workspaces/{ws}/projects/{project}/previews/start
POST /api/workspaces/{ws}/projects/{project}/previews/stop
```

Start runs the project's own `preview.command` — Perch never sends a command, only "start it", so a
project can only be asked to run what it already said it runs. A project with no `preview.command`
is a 422 saying so.

The answer waits for the port to answer (up to 45 seconds) and then says what happened:

```json
{"running": true, "started": true, "serving": true, "port": 3000, "pid": 4711,
 "command": "bun --hot src/index.ts", "started_at": "…", "exit_code": null, "log": "listening on …"}
```

- `started` is false when it was already running — pressing Start twice is one dev server, not two.
- `serving` is whether the port answers, asked of the runner rather than of the last notification.
- `log` is the tail of the dev server's own output, so a start that fails says why instead of
  leaving an empty frame. The Preview tab shows it.

The runner holds the process (`preview.start` / `preview.stop` / `preview.status` on the §7.6
channel) and writes its output to `<projects>/.previews/<project>.log`, outside the project so git
never sees it. Stopping asks politely first — a dev server gets a `SIGTERM` and closes its own port
— and then takes the whole process tree, because what holds the port is usually a child of the
shell. A runner that restarts takes its dev servers with it; press Start again.

## The demo workspace

A Perch with nothing in it is a set of empty states. `PERCH_DEMO_WORKSPACE` (default on, spec §4
"first run") seeds the first workspace just after the setup wizard: the channels `#general`,
`#builds` and `#the-nest`, two bots from the Forge's own templates (`@helpdesk` and `@editor`), and
and a project made from the `bun-api` stack — plus a message in `#general` saying what is there and
which button starts the project.

The seed does not start the dev server: it runs behind the wizard's response, and a first run that
leaves a process on a port nobody asked about is a surprise. `perch demo`, where somebody did ask,
starts it.

It is made through the same services your clicks go through, so nothing in it is a fixture. It is
also idempotent: what is already there is left alone.

Turn it off with `PERCH_DEMO_WORKSPACE=false` before the first run.

On a laptop, one command does all of it:

```sh
perch demo
```

That is `perch dev` with the wizard already done and the workspace already seeded. It prints the URL
and the account it made:

```
perch demo: http://127.0.0.1:3000
  data: /home/you/.perch-demo
  sign in: demo@perch.local / perch-abc123-def456
  channels: #general #builds #the-nest
  bots: @helpdesk @editor
  project: bun-api (ready) on port 3000
```

Change that password if the machine is not only yours, or pass `--email` and `--password`. The
bots need a model before they can answer — Settings → Brains. `perch demo --no-project` skips the
project; `--template <id>` picks a different stack; `--data-dir` puts it somewhere other than
`~/.perch-demo`, so a demo never lands on top of the Perch you actually use.
