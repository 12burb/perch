# Shipping: the Deploy button and the database panel

Two drawer tabs in Code mode, both running on a connection (spec §5.5; task 2.15). **Deploy** asks a
provider to build this project and says so in a channel. **Database** shows what a connection's
database has, and reads from it.

## Deploy

Open a project, open the drawer (⌘J), choose **Deploy**.

| Field | What it is |
|---|---|
| **Through** | The Vercel connection to deploy on. Its token is minted for the call and goes nowhere else. |
| **Announce in** | The channel the card is posted to. A deploy nobody can see is not a deploy anyone can act on. |
| **What for** | A preview, or production. |

Perch asks the provider to build the project's repository at its current branch — a git-based
deploy, so the build runs where the provider's builds run and nothing is uploaded from here.

### The card is the record

There is no deployments table. The **card posted in the channel is the deploy**: it carries the
provider, the deployment's id, the branch, where it got to, and the preview URL once there is one.
The panel keeps asking the provider while the build runs and rewrites that same card, so the thread
fills itself in — the message says *Building* when it is posted and *Ready* with the URL when the
build finishes, without a second message under it.

That means scrolling back to a deploy from last week shows what happened, not what somebody hoped
would happen. It also means a deploy is discussed where everything else is: in the thread under its
own card.

### Requirements

- A **Vercel connection** (Settings → Connections; the paste lane or the MCP lane both work).
- A **repository**, because a git-based deploy builds one. A cloned project already knows where it
  came from. A project created empty and pushed somewhere later is asked for the URL by the panel
  itself, and remembers it (`PATCH /api/workspaces/{ws}/projects/{project}`).
- The project must already exist on the provider under the same name as its Perch key.

## Database

Choose **Database** in the same drawer. It lists every table in the connection's database with its
columns, and takes one statement. The table list and a statement's rows are drawn a hundred at a
time, with **Show more** for the next hundred, so a schema with thousands of tables or a `select *`
over a big table does not build the whole of it into the page.

Nothing here speaks any vendor's REST API. A provider with a database has an MCP server with tools
for it, and Perch already proxies those with the connection's own token, an allow-list, and an audit
line ([the MCP gateway](./mcp-gateway.md)). The panel is that gateway with two tool names read off
the connector's manifest:

```yaml
db:
  tables_tool: list_tables
  schemas_arg: schemas
  schemas: [public]
  query_tool: execute_sql
  query_arg: query
```

So the next provider whose MCP server can list tables needs a YAML file, not a release.

### Read-only by default

The panel reads. A statement that is not plainly a read is refused **before the provider is
touched**, with a 451 and the rule that said so (`db.read_only`):

- one statement only — a read followed by a write is not a read;
- it must begin with `select`, `with`, `explain`, `show`, `table`, or `values`;
- and no data-modifying word may appear anywhere in it, so a write cannot hide inside a CTE.

The last rule is deliberately blunt: a `SELECT` whose own identifiers spell `update` is refused too.
That is the trade a read-only panel should take, and the refusal says exactly why.

Writes are not forbidden forever — they need a session and a permission prompt (spec §5.5 "SQL with
permission prompt for writes"), which is Phase 3's. Until then the honest answer to "can this panel
drop my table" is no, and it is enforced here rather than trusted upstream, because "the server is
in read-only mode" is a promise somebody else made.

## Who may do what

| Action | owner | admin | member |
|---|---|---|---|
| Deploy a project | ✅ | ✅ | ❌ |
| Check where a deploy got to | ✅ | ✅ | ✅ |
| Browse a connection's database | ✅ | ✅ | ✅ |

A member can see a deploy's card like anyone else in the channel; pressing the button is a project
write, which is an admin's.

## Not here yet

Build and runtime logs streamed into the thread, runtime-error alerts into `#alerts`, env-var changes
behind a permission prompt, migrations from sessions, edge-function deploys, and advisor findings
into a channel (spec §5.5) arrive with the Phase 3 connector work. The **Build log** link on a card
goes to the provider's own page for the deployment in the meantime.
