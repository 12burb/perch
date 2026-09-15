# Repo intelligence

Perch can read a project the way you would: once, carefully, and then remember. What it remembers is
the **codebase index** — every file worth reading, cut into pieces, with the words searchable and,
when you have a model for it, the meaning too. Three things use it:

- **`@codebase` in a session.** The agent is handed the places your question is about, each citing
  its file and lines, before your question.
- **The Codebase panel** in Code mode: index the project, ask it something, open what it answers.
- **The Code lane** of the search box: one question, every project you can see.

And one thing is built from the same walk of the repository: an **AGENTS.md draft**, which is the
operating manual a new project starts from.

## Indexing

Open a project in Code mode, open the drawer (⌘J), and pick **Codebase**. **Index now** reads the
project and writes the rows; the badge afterwards says how many files and chunks, and whether the
index has meaning as well as words.

Over the API:

```http
POST /api/workspaces/{ws}/projects/{project}/index
{ "wait": false }
```

Without `wait` the pass is queued and `project.updated` says when it landed — which is what you want
for anything larger than a toy, because reading a repository takes longer than a request should.
With `wait: true` the pass runs inline and the reply says what it indexed; that is what the panel's
button uses, and what a script should use.

`GET .../index` says what is there now:

```json
{
  "chunks": 412,
  "files": 88,
  "commit_sha": "9f1c…",
  "embedded": 412,
  "indexed_at": "2026-09-15T10:04:11.000Z",
  "embedding_model": "Nest Embedder"
}
```

### What is read, and what is not

A file is indexed when its extension is one Perch knows (source, config, or prose) and it is not in
a directory that belongs to a tool. `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`,
`target`, `vendor`, `.next`, `.turbo`, `.venv` and `__pycache__` are never walked; lockfiles are
never read. A file over 400 KB is skipped — a generated bundle is not what `@codebase` is for — and
one pass reads at most 3,000 files, shallowest first.

### How a file is cut

- A **symbol** chunk is one declaration — a function, a class, a type — found by the shape its
  language declares things in. This is what lets an answer say "`mintShareToken` in
  `packages/preview/src/share.ts:12`" rather than "somewhere in that file".
- A **chunk** is a 60-line window with 10 lines of overlap, which is what everything else falls back
  to.
- A **doc** chunk is a section of Markdown, split at its headings, because that is where its meaning
  already is.

There is no parser. A declaration Perch's patterns miss is still inside a line window, so it is
still findable — one level less precisely. (ADR-0107 makes the same trade for the inspector.)

### Rebuilding

A pass writes every chunk for the current commit before dropping the rows of any other commit, so a
search *during* a reindex finds the old answer rather than none. Perch does not watch the filesystem:
an index you press is one you can reason about, and the panel says how many files and when, so a
stale answer is diagnosable rather than mysterious.

## Embeddings are optional

The index has two halves, and only one of them costs anything.

**The words** are a Postgres tsvector, generated from the chunk's symbol, path and content. They are
always there. `websearch_to_tsquery` reads what a person typed rather than a query language, so a
question with a comma in it is still a question.

**The meaning** is a pgvector column, and it is filled only when the workspace has named a brain for
it: a model profile whose **Default for** is `embedding` (Settings → Brains). Without one, the index
still exists, `@codebase` still works, and the panel says *Words only*.

When both halves answer, the two ranked lists are merged with reciprocal rank fusion — a chunk both
halves found comes before one either found alone. No shared scale is needed between "how well the
words matched" and "how near the vectors are".

Any provider's embedding model can fill the column: Perch asks for 1024 dimensions, and folds or
pads whatever comes back before normalising it (ADR-0110). A provider that refuses does not fail the
pass — the rows go in without vectors and the reply's `embedding_skipped` says why. The key never
leaves the vault: the gateway makes the call, and the request is never repeated on failure.

## `@codebase`

Type `@codebase` anywhere in a turn:

```
@codebase where is the retry budget?
```

Perch searches the project's index for the question with the marker removed, takes the best six
chunks, and puts them in front of your question on the way to the engine:

````
From this project's index (each block says which file and lines it came from; cite them):

src/retry.ts:1-8 — RETRY_BUDGET
```
/** How many times a failed delivery is tried again. */
export const RETRY_BUDGET = 5;
```

@codebase where is the retry budget?
````

Two things are deliberate here.

**The transcript keeps your words.** The context rides beside the turn, not inside it: what you see
yourself having said is what you typed, and twelve thousand characters of your own source code never
land in the conversation under your name.

**Nothing happens without the marker.** A turn that does not say `@codebase` is never searched for.
An index that is empty, or a search that fails, leaves the turn alone — an agent that has to look for
itself is worse off than one that was handed the file, and better off than one that was handed an
error.

## Searching

In the Codebase panel, or over the API:

```http
GET /api/workspaces/{ws}/projects/{project}/codebase?q=retry+budget&limit=8
```

Each hit is a path, a line range, the symbol if it has one, and the content — the same rows
`@codebase` hands the model, which is the point of showing them: what the panel shows is what an
agent would have been given.

A project with nothing indexed answers `409` rather than an empty list, because "no index" and "no
match" are different problems and only one of them is fixed by pressing **Index now**.

The **Code** lane of the search box (⌘K → Search, or `/{workspace}/search`) asks the same question of
every project in the workspace at once, and each hit links to `…/code/{project}?file=…&line=…`, which
opens the file there. That lane is the words only: a search box that fires as you type should not
call an embedding provider on every pause, and it is asking across projects that may not share an
embedding model. For the meaning, ask one project — in the panel, or with `@codebase`.

## The AGENTS.md draft

**Draft AGENTS.md** in the Codebase panel writes an operating manual from what the repository shows:
what it is (the first paragraph of the README), its layout, its commands (the scripts in
`package.json`), and what to read first. The judgement calls are left as TODOs, because an operating
manual nobody wrote is worse than none.

**Save to the project** writes it as `AGENTS.md` in the project root, where an agent reads it at the
start of every session. Over the API:

```http
POST /api/workspaces/{ws}/projects/{project}/agents-draft
{ "save": true }
```

## Where it lives

| Piece | Where |
|---|---|
| Chunking, context block, AGENTS.md draft | `packages/repo` |
| The embedding call and the 1024-dimension fit | `packages/gateway/src/embeddings.ts` |
| The rows and the two searches | `apps/api/src/repos/repo-index.ts` |
| Indexing, merging, `@codebase` | `apps/api/src/services/repo-index.ts` |
| The routes | `apps/api/src/routes/repo-index.ts` |
| The queue handler | `apps/api/src/jobs/repo-index.ts` |
| The panel | `apps/web/src/code/codebase-panel.tsx` |
| The table | `packages/db/src/schema/repo.ts` |

The decisions behind all of it are ADR-0110 in [`DECISIONS.md`](../DECISIONS.md).
