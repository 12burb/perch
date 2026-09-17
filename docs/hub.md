# The Hub

Perch ships with connectors, bot templates, skills and starter stacks. Before the Hub they lived
behind four different screens, and you had to know which one to go to. The Hub is one page for all
of them: **`/<workspace>/hub`**, or ⌘K → Hub.

## What is in it

| Kind | Where it comes from | What Install does |
|---|---|---|
| **Connections** | `connectors/<id>/manifest.yaml` | Takes you to the Connections card for that provider |
| **Bots** | the Forge's templates | Creates the bot in this workspace, optionally in a channel |
| **Skills** | the skills those templates carry | Adds one skill to a bot you name |
| **Templates** | the starter stacks | Creates a project from the stack |

Every row says what pressing Install will do before you press it, and every row says which file in
the build it came from — so "what is this and where does it live" is answerable without leaving the
page.

## What is not in it

There is no remote registry, no publishing, no ratings and nothing to trust. **Everything in the
Hub came from the same commit as the Perch that is serving it** (ADR-0158): the index is built from
`connectors/`, `@perch/bots` and `@perch/templates` at startup. Upgrading Perch is what changes what
the Hub has. A Hub that fetches from the internet is the *marketplace*, and the spec puts that in
Later — on purpose, because a marketplace is a supply chain and a supply chain needs signatures,
provenance and a way to revoke, none of which v1 pretends to have.

## Installing something

Every install is the same call the screen behind it would have made. A bot from the Hub is the same
bot the Forge makes, a project from a template is the same project the New project button makes, and
a skill lands on the bot's spec the same way an edit would. Nothing here has a second code path, and
nothing here has a permission of its own either: installing a bot needs `bots.write`, a template
needs `projects.create`, and a connection needs no more than being able to read the workspace's
connections, because it does not connect anything — it takes you to where you can.

Installing something twice is not an error and not a duplicate. The Hub says the thing is already
here and leaves it alone.

## From the API

```http
GET  /api/hub?kind=bot&q=news
POST /api/workspaces/{ws}/hub/install   { "kind": "bot", "id": "grok-newsroom", "channel": "…" }
```

The index is the same for every workspace, so `GET /api/hub` needs a session and nothing else. The
install is authorized as whatever it is about to do. The response says what happened in a sentence,
whether anything was installed, and where to go next:

```json
{
  "item": { "kind": "bot", "id": "grok-newsroom", "name": "Grok Newsroom", "…": "…" },
  "installed": true,
  "detail": "@grok is in #newsroom. Say its name and it answers.",
  "href": "/nest/home/0f1e…",
  "bot_id": "…"
}
```

## Adding to it

Add the thing where it already belongs — a manifest in `connectors/`, a template in
`packages/bots/src/templates.ts`, a stack in `templates/src/stacks.ts` — and the Hub picks it up:
`packages/hub` reads those three sources and nothing else. `packages/hub/test/catalog.test.ts`
asserts the index holds every one of them, so something added to a source and missing from the Hub
fails the build rather than going quietly unlisted.
