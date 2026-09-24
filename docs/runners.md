# Runners

A runner is where code lives and agents work (spec §3.2): the hosted runner is a container the
supervisor starts per workspace from the runner image; a local or remote runner is `perch runner
connect` on a machine you own (task 1.3). Every runner speaks only the §7.6 protocol to the api, over
one outbound WebSocket, so the api never needs to reach into a runner's network.

## The control channel (`/api/runner`)

1. The runner opens `wss://<api>/api/runner` with `Authorization: Bearer prt_…`, a **connect token**
   minted for its runner row (`runner_tokens`: sha256 hash, expiry, revocation). A wrong, expired, or
   revoked token gets the §7.8 `forbidden` body with `details.reason = "runner_token_invalid"` and no
   socket.
2. Its first message is a JSON-RPC 2.0 request, `runner.register {name, kind, capabilities, versions}`,
   within 5 s. The api checks the kind against the row, validates the capabilities, marks the row
   online, publishes `runner.registered` and `runner.online`, and answers
   `{runner_id, cap_secret, heartbeat_ms}`.
3. From then on the runner sends notifications (`runner.heartbeat {load, sessions}` every
   `heartbeat_ms`, later `ports.changed`, `session.event`, `pty.data`, …) and the api sends requests
   (`ports.list`, `fs.*`, `git.*`, `pty.*`, `session.*`, `exec`, …). Three missed heartbeats, or a
   closed socket, mark the runner offline (`runner.offline`) and detach it from the registry.

### Capability tokens

Every api → runner request carries `workspace_id`, `user_id`, and `cap`: an HMAC-SHA256 token over
`{ws, user, method, exp}` minted with the connection's `cap_secret`, good for 60 s. The runner verifies
the signature, the expiry, and that the claims name the request's workspace, user, and method before
any handler runs; a failure is JSON-RPC error `-32001`. A local or remote runner additionally refuses
requests for any user other than its owner unless a `grant` is attached (`-32003`). Unknown or
not-yet-implemented methods are `-32601`; bad params `-32602`.

## Hosted mode: the runner image

`ghcr.io/12burb/perch-runner` runs `bun /opt/perch/apps/runner/src/main.ts` with:

| Variable | Meaning |
|---|---|
| `PERCH_API_URL` | the api's public URL (required) |
| `PERCH_RUNNER_TOKEN` | the connect token, `prt_…` (required; never logged) |
| `PERCH_RUNNER_NAME` | shown on the Environments page (default: the container hostname) |
| `PERCH_RUNNER_KIND` | `hosted` (default), `local`, or `remote` |
| `PERCH_RUNNER_OWNER_USER` | local and remote runners: the owner's user id |
| `PERCH_RUNNER_ISOLATION` | `users` (set by the image): each member runs as a uid of their own; needs the agent to be root on Linux, and the runner will not start without it once asked ([below](#who-a-process-runs-as-adr-0171)) |
| `PERCH_HOMES_DIR` | where members' homes are (default `/data/homes`) |

The supervisor (task 1.2) mints the token, starts the container with these variables, and watches
`runner.online`. The agent reconnects with jittered backoff (1 s to 30 s) when the api restarts; a
refused upgrade three times in a row ends the process with exit code 1 so the supervisor sees it.

## The supervisor (hosted runners)

The `supervisor` entrypoint of the api image (`docker compose` service `supervisor`, the only service
that mounts the Docker socket) runs the hosted runners:

- **On demand.** The api enqueues `supervisor.ensure {workspaceId}` (jobs queue); the supervisor creates
  one container per workspace from `PERCH_RUNNER_IMAGE` with the limits of `PERCH_RUNNER_LIMITS`
  (`cpus=2,memory=4g,pids=512`), a fresh connect token, and the labels `dev.perch.role=runner`,
  `dev.perch.workspace=<id>`, `dev.perch.runner=<runner id>`. A workspace whose container is already
  running gets nothing new.
- **One workspace's files.** The container mounts only its own workspace's directory of each volume:
  `<workspace>/` of the homes volume at `/data/homes`, and `<workspace>/` of the projects volume at
  `/data/projects/<workspace>` — the paths the runner always used, so nothing inside it moved. The
  supervisor makes both directories first, through its own mounts of the two volumes (compose puts
  them at `/data/homes` and `/data/projects`), and fails with a message saying which one it could not
  see or write. The mount is a volume subpath (Docker Engine 26, API 1.45, and later) or, on an older
  Engine, a bind of the same directory under the volume's mountpoint (ADR-0171).
- **One live token.** The token a new container carries is the only one its runner has: every older
  one is revoked when it is minted, so the environment of a container that is gone is worth nothing.
- **Homes are per workspace.** A person's home (`HOME`, where a CLI keeps its login) is
  `/data/homes/<user>` inside their workspace's container, which is `<workspace>/<user>` of the volume.
  Before ADR-0171 it was one home per person across every workspace; the first time a workspace's
  homes directory is made, each member's old home is copied into it once, and from then on each
  workspace's copy is its own.
- **Shared mode.** `PERCH_RUNNER_MODE=shared` runs one container for the whole instance, on a runner row
  without a workspace, which every workspace may use. It mounts the whole of both volumes, so every
  workspace's projects are in one container: it is for one team, not for tenants who must not see each
  other ([security](security.md#runners-what-is-kept-apart)).
- **Idle stop.** The api records `idle_since` on every heartbeat that carries no sessions; after
  `PERCH_RUNNER_IDLE_MINUTES` (30) the supervisor stops and removes the container and the next request
  starts a new one. A container whose runner has been offline for as long (a crashed agent) is removed
  the same way.
- **Reconcile.** At start, containers no runner row owns are removed and rows pointing at containers
  that no longer exist are cleared.

| Variable (supervisor) | Meaning |
|---|---|
| `PERCH_RUNNER_MODE` | `docker` (default in team mode), `shared`, or `inprocess` (laptop mode; no supervisor) |
| `PERCH_RUNNER_IMAGE` | the runner image (`ghcr.io/12burb/perch-runner:<tag>`) |
| `PERCH_RUNNER_LIMITS` | `cpus=<n>,memory=<size>,pids=<n>` |
| `PERCH_RUNNER_IDLE_MINUTES` | minutes without sessions before a container is stopped |
| `PERCH_RUNNER_API_URL` | what runner containers reach the api at (`http://api:3000` in compose; the public URL when unset) |
| `PERCH_RUNNER_HOMES_VOLUME`, `PERCH_RUNNER_PROJECTS_VOLUME`, `PERCH_RUNNER_NETWORK` | override the volume and network names; by default the supervisor mirrors its own `/data/homes` and `/data/projects` mounts and its first network |

Design notes: ADR-0067.

## Your own machine (local and remote runners)

On the **Environments** page of a workspace (the settings sidebar, or the command palette), "Connect a
machine" registers a runner of your own and shows its connect token once, inside the command to run:

```sh
perch runner connect https://perch.example.com --token prt_… --name "Laptop"
```

The machine appears in the list within seconds and flips to Online; it runs your sessions, terminals,
and previews, and refuses requests for anyone else unless a grant is attached (spec §3.2, §7.6). Your
subscriptions, keys, and code stay on the machine. `--kind remote` marks a box you own elsewhere; the
command reconnects on its own when the api restarts. Remove the machine from the page to revoke its
token; a connected one is disconnected at once. The `perch` binary is on the release page; on a machine
with Bun, `bun apps/runner/src/main.ts` with `PERCH_API_URL` and `PERCH_RUNNER_TOKEN` does the same.

## From code

```ts
import { connectRunner } from "@perch/runner";

const client = connectRunner({ apiUrl, token, name: "gpu-box", kind: "remote", ownerUserId });
await client.registered(); // { runner_id, cap_secret, heartbeat_ms }
await client.close();
```

On the api side every connected runner is a `RunnerLink` in the `RunnerRegistry`
(`booted.runners`): `link.call("ports.list", { workspace_id, user_id })` mints the capability token
and awaits the runner's answer; `link.onNotification` delivers heartbeats and events. Laptop mode
attaches the in-process runner through the same interface without a socket.

Design notes: ADR-0066.

## Projects on a runner

Each project is a directory at `<root>/<workspace id>/<project id>` (root: `/data/projects` in the
runner image, `~/.perch/projects` for `perch runner connect` and laptop mode, or `PERCH_PROJECTS_DIR`).
Two api → runner methods beyond the spec's §7.6 list create and remove them (ADR-0069):

| Method | Params | Result |
|---|---|---|
| `project.setup` | `{project, source: {kind: "empty", defaultBranch?} \| {kind: "upload"} \| {kind: "clone", url, branch?, auth?}, postCreate?}` | `{path, defaultBranch, head, config, configError?, devcontainer, devcontainerError?, postCreate?}` |
| `project.remove` | `{project}` | `{removed}` |

`fs.write` gained `encoding: "utf8" | "base64"` so uploads carry binary files. Clone credentials
(`auth: {kind: "token", token, username?}` or `{kind: "ssh", privateKey}`) reach git through a
credential helper fed from the environment or a 0600 key file handed to `GIT_SSH_COMMAND`; the
runner strips `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH*`, and `GIT_CONFIG_*` from git's environment,
spawns `git` directly (no URL or secret on the command line comes from Perch), and scrubs
`scheme://user@` from error messages. See [`projects.md`](projects.md).

Git holding a credential — a clone, or `git.push` with `auth` — is told on its own command line,
which git reads after every config file (ADR-0171): `core.hooksPath=/dev/null` (no hook runs; a
repository's `core.hooksPath` can point anywhere in the tree), `credential.helper=` (every helper
anyone configured is dropped) and then Perch's helper as `credential.<scheme>://<host>.helper`, so it
answers for the remote's own host only, `http.sslVerify=true`, and `protocol.allow=never` with only
the remote's own transport allowed. A token goes only over https (plain http only to this machine),
a deploy key only over ssh. Before a credentialed push the runner reads `git remote get-url --push
origin` (every `insteadOf` rewrite applied) and refuses, before git pushes, a URL on another host
than the one the project was cloned from (recorded at clone time in `.perch-remotes.json`, beside
the runner's other state where no member can write; a project that was never cloned here records
its first credentialed push's host), or a repository whose own config sets a proxy, a CA, TLS
verification or a pinned address for the transport.

## fs, git, ports, and exec on a runner (task 1.5)

Every runner answers these §7.6 methods through `defaultHandlers()` (apps/runner/src/handlers.ts);
each one resolves paths inside the project directory and goes through the policy hook first.

| Method | Params (beyond `workspace_id`, `user_id`, `cap`) | Result |
|---|---|---|
| `fs.list` | `{project, path}` | `{entries: [{name, type: file\|dir\|symlink\|other, size, mtime}]}`, directories first |
| `fs.read` | `{project, path}` | `{content, encoding: utf8\|base64, size, truncated}` (binary → base64; 2 MiB cap) |
| `fs.write` | `{project, path, content, encoding?}` | `{bytes}`; emits `fs.changed {project, paths, kind}` |
| `fs.stat` | `{project, path}` | `{exists, type?, size?, mtime?}` |
| `fs.search` | `{project, query, glob?, limit?, regex?, ignoreCase?}` | `{matches: [{path, line, column, text}], truncated, tookMs, engine}` |
| `git.status` | `{project}` | `{branch, tracking, ahead, behind, clean, files: [{path, index, workingTree}]}` |
| `git.diff` | `{project, ref?, to?}` | `{diff, files: [{path, additions, deletions, binary}], patches: FileDiff[]}`. No `ref`: the working tree against HEAD, tracked files only (the index on an unborn branch). With `ref`: that ref against the tree as it is now, untracked files included and ignores honored. With `to`: one ref against another |
| `git.apply` | `{project, patch, reverse?}` | `{files}`; a unified patch applied to the working tree, `--reverse` to take it back out. Every path goes through the policy's `fs.write` rules; emits `fs.changed` |
| `session.checkpoint` | `{session_id, turn, project}` | `{git_ref}`; snapshots the working tree as a parentless commit under `refs/perch/checkpoints/<session>/<turn>` (ADR-0079). Line-ending conversion is off in this lane, so a snapshot and a restore do not rewrite a file's endings |
| `session.restore` | `{session_id, turn, project, git_ref?}` | `{git_ref, files}`; rewrites what differs from that checkpoint and deletes what did not exist then. `git_ref` names the commit (a fork's checkpoints live under the session it copied); without it the session's own ref is resolved |
| `git.commit` | `{project, message, paths?, author?}` | `{commit, branch, summary}`; all changes when `paths` is omitted |
| `git.push` | `{project, branch?, auth?}` | `{pushed, remote, branch, output}`; `auth` as for a clone (token or ssh key) |
| `git.branch` | `{project, name?, create?}` | `{current, branches, created?}`; switches or creates when `name` is given |
| `worktree.create` | `{project, branch, base?}` | `{path, branch}` at `<project>.worktrees/<branch>` |
| `worktree.remove` | `{project, branch}` | `{removed}` |
| `ports.list` | | `{ports: [{port, pid?}]}` (Linux: /proc/net/tcp; macOS: lsof; Windows: netstat) |
| `exec` | `{command, cwd, timeout}` | `{exitCode, stdout, stderr, timedOut, durationMs}` (1 MiB caps; the process tree is killed at the budget) |

`fs.search` is ripgrep (`rg --json`, literal by default, smart case) when the machine has it (the
runner image does) and an in-process walk otherwise; both answer in path-then-line order. The
acceptance benchmark in apps/runner/test/fs.test.ts searches a 50,000-file tree in ~110–140 ms on
ripgrep on Linux (the budget is asserted there; macOS CI VMs take ~650 ms on the same tree, so the
test reports the timing on other platforms). The runner reports its `git` and `ripgrep` versions in
`capabilities.versions`.

The watcher behind `ports.changed` polls every 2 s and reports the whole list on the first look and
on every change; the api keeps it per runner (the Environments list shows it), answers
`GET /api/workspaces/{ws}/runners/{runner}/ports` live, and announces new ports on a workspace's
runner as `preview.port_detected` (spec §5.6).

## Shells and stream sockets (task 1.7)

The `pty.*` methods run a shell per person and project; output and input travel on a data socket
rather than on the control channel (spec §7.6: "data streams as extra sockets at
`/api/runner/stream/{stream_token}`").

| Method | Params (beyond `workspace_id`, `user_id`, `cap`) | Result |
|---|---|---|
| `pty.open` | `{cols, rows, cwd, user, pty_id?}` | `{stream_token, pty_id, reattached}`; `pty_id` reattaches to a shell the runner still holds |
| `pty.input` | `{pty_id, data}` | `{written}` (the stream carries input too; this is the fallback) |
| `pty.resize` | `{pty_id, cols, rows}` | `{resized}` |
| `pty.close` | `{pty_id}` | `{closed}` |

Runner → api notification: `pty.exit {pty_id, code}`. After `pty.open` the runner opens
`GET /api/runner/stream/{stream_token}` (a WebSocket, its connect token as the bearer, the same
`prt_` token as the control channel); the api pairs that socket with whoever asked for the stream
(`StreamHub`, apps/api/src/runners/streams.ts) and drops tokens nobody claims within 15 s. Each
token is single-use. The in-process runner of laptop mode pairs stream ends in memory through the
same `RunnerLink.openStream(token)` interface. The `pty.data` notification the spec lists is not
used while output has a stream of its own (ADR-0073).

The shell: tmux where the machine has it (`tmux -L perch-<hash> -u new-session -A -s perch-<hash>
-x cols -y rows -c cwd ; set-option status off`; the hash is of the user and directory, so a reopen
finds the same session), otherwise `$SHELL -l` (`%COMSPEC%` on Windows). The server is the person's
and directory's own (`-L`): tmux copies the environment of whoever starts a server into it once and
starts every session on it from that, so on one shared server a second person's shell had the first
one's `HOME`, `PERCH_USER` and project environment (ADR-0171). A shell whose stream closed stays for ten
minutes (`graceMs`) with 64 KiB of scrollback (`scrollbackBytes`) replayed to the next stream. Its
environment is the runner's with every `PERCH_*` variable blanked (the connect token never reaches
a shell), plus `TERM=xterm-256color`, `PERCH=1`, `PERCH_USER=<user id>`, and, on a hosted runner,
`HOME=/data/homes/<user>` (`PERCH_HOMES_DIR`), created on first use and, on a hosted runner,
owned by the member's own uid (ADR-0171). See
[`terminal.md`](terminal.md).

The same blanking applies to everything else the runner starts — `exec`, a project's dev server
and `postCreateCommand`, MCP servers, git (so a repository's hooks see nothing either), agent
version probes, ripgrep and the screenshot browser — through one helper, `childEnv`, and a test
that fails on any process the runner starts without it (ADR-0160). Blanking keeps the token out of
a child's own environment only: a child running as the runner's uid could read the runner's from
`/proc`. Who a child runs as is what closes that (next section).

### Who a process runs as (ADR-0171)

A hosted runner is several people's. The runner image sets `PERCH_RUNNER_ISOLATION=users` and runs
the agent as root, and on Linux with root the agent starts nothing as root:

- **Every member runs as a uid of their own**, allocated from 20000 the first time the runner sees
  them and kept in `/data/homes/.perch-uids.json` (root's, mode 600), so the same person gets the
  same uid after a restart. Each gets a passwd entry (`perch-u<uid>`, group 1000) and a home,
  `/data/homes/<user>`, owned by them and mode 700: nobody else's shell, agent or dev server can
  read the CLI logins in it.
- **Every child goes through one helper** (`asUser` in `apps/runner/src/identity.ts`), which puts
  `setpriv --reuid=<uid> --regid=1000 --clear-groups --inh-caps=-all --bounding-set=-all
  --no-new-privs --` in front of it: shells, `exec`, dev servers, `postCreateCommand`, MCP servers,
  ACP, OpenCode and cli-harness agents, git, ripgrep. simple-git's git goes through
  `/usr/local/bin/perch-as`, which does the same from a uid in its environment. A child that is
  nobody's (a version probe, the screenshot browser, which may be looking at another member's page
  without its sandbox) runs as uid 1000. The runner's own read-only queries of the machine (ports,
  a pid's children) run as the agent; `apps/runner/test/env.test.ts` lists them and fails on any
  other process started without the helper.
- **What the runner reads and writes for a member** — `fs.*`, an agent's file requests, a
  project's `.perch/project.json` — it reads and writes with that member's filesystem credentials
  (`setfsuid`/`setfsgid`), so a link a member made leads the root agent nowhere the member could not
  go themselves.
- **A workspace's projects are its members' together.** `/data/projects/<workspace>` is root's,
  group 1000, mode 3775; every project directory the runner makes is group 1000 and setgid, the
  runner's umask is 002, and repositories are `core.sharedRepository=group`, so what one member
  writes another can change. git accepts a checkout another member made (`safe.directory=*` in
  `/etc/gitconfig`, and on the runner's own git command lines). A project from before this is made
  group-writable once, when the runner starts.
- **git holding a credential** (a clone or push with a token or the deploy key) runs as
  `perch-git` (uid 19999), which nothing else runs as: git's environment and the key file are
  readable by every process of the uid git runs as, and the member's own agent is one of those.

The connect token is then out of every child's reach: `/proc/1/environ` is root's. A runner that is
not isolated — a local runner (`perch runner connect`), a hosted one without root — runs its
children as its own uid, and on Linux makes itself non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`) at
start, which makes its `/proc` entries root's too; where that cannot be done it says so once in its
log. The in-process runner of laptop mode is the api's own process and does neither.

Everything a caller sends is a value on the runner's command lines, never an option (ADR-0164):
a search query goes to ripgrep as the value of `--regexp`, git is told where its options end
before any ref and given `--` before any path, and a branch name has to satisfy `BRANCH_NAME`
(what `git check-ref-format --branch` accepts, minus anything that reads as an option or a
refspec) on both ends of the protocol. A path is kept inside the project on disk too: a link that
points outside it is not followed, and a write never goes through a link.

## Sessions on a runner (task 1.9)

The `session.*` methods run agent sessions where the project is (spec §7.6); the runner answers
`session.create` and `session.send` and streams a round's EngineEvents back as `session.event
{session_id, event}` notifications (`session.send` returns `{started}` as soon as the round is
under way).

| Method | Params (beyond `workspace_id`, `user_id`, `cap`) | Result |
|---|---|---|
| `session.create` | `{session_id, project, engine, agent?, model, mode, worktree?, env?}` | `{engine_session_id?, agent?: {id, name}, modes?: {current, available}}`. `agent` names the program to run — an ACP agent id, a CLI id — and is additive to §7.6 (ADR-0081); without it the runner uses its default agent, and cli-harness asks for the name unless it hosts exactly one CLI. `env` carries the brain's provider key and base URL, which go to the process and nowhere else |
| `session.send` | `{session_id, turn: {text, attachments?}, mode?}` | `{started}` |
| `session.permission` | `{session_id, permission_id, answer}` | `{answered}` |
| `session.cancel` | `{session_id}` | `{cancelled}` |

`engine` is `acp` (ADR-0075), `opencode` (ADR-0076), or `cli-harness` (ADR-0077; local runners
only, behind the api's `cli_harness` flag; `model.provider` is `codex` or `claude`). For
`acp`, `model.provider` names the registry agent (`gemini`, `codex`, `claude`, `goose`, `opencode`,
`qwen`, `cline`, or an id from `PERCH_ACP_AGENTS`; `engine`/`default` → `PERCH_ACP_AGENT`, default
`gemini`). For `opencode`, the runner starts `opencode serve` per project directory and environment (the
pinned binary of the runner image, or `opencode` on PATH; two people on one project, or one
person on two brains, are two servers, since a server's credentials are its environment's,
ADR-0161) — or talks to one already running, when `PERCH_OPENCODE_URL` names it, one per
directory — and the model is OpenCode's unless the session names one. The agent runs in the project directory (or the named worktree) with the shell
environment of [`terminal.md`](terminal.md) plus the session's `env`; sessions idle for thirty
minutes are closed, and so are OpenCode servers with no session left. Runners report
`engines: ["acp"]` plus `"opencode"` when the binary — or a server named by
`PERCH_OPENCODE_URL` — is there, and the ACP agents on PATH as `capabilities.agents`. See [`sessions.md`](sessions.md).

| Variable | Does |
|---|---|
| `PERCH_ACP_AGENT` | the agent for sessions that name none (default `gemini`) |
| `PERCH_ACP_AGENTS` | JSON `{ "<id>": { "name", "command"?, "args"?, "npx"?: { "package", "args"? }, "env"? } }` adding or overriding agents |
| `PERCH_OPENCODE_URL` | an `opencode serve` already running, for every project directory; nothing is spawned then |
| `PERCH_AGENT_MANIFEST` | where to read the agent manifest (default `/opt/perch/agents.json`) |

### The CLIs the image ships

The runner image installs four official CLIs at pinned versions (task 4.6), from one file —
`deploy/agents.json` — which then travels in the image at `/opt/perch/agents.json`:

| Agent | Package | On PATH as | How a session starts it |
|---|---|---|---|
| Codex | `@openai/codex` | `codex` | the `codex-acp` bridge, also installed |
| Claude Code | `@anthropic-ai/claude-code` | `claude` | the `claude-agent-acp` bridge, also installed |
| Gemini CLI | `@google/gemini-cli` | `gemini` | `gemini --acp`, which it speaks itself |
| OpenCode | `opencode-ai` | `opencode` | `opencode serve` (the `opencode` engine) or `opencode acp` |

Because they are installed, a session starts on any of them without fetching anything, and the
runner reports them in `capabilities.versions` — so the Environments page can say which Codex a
session would run on without starting one. A runner with no manifest (a laptop joined with `perch
runner connect`) asks each CLI its own version instead, and reports only what is really there.

None of them carries a credential from the image: every one reads the person's own home volume at
run time (spec §3.6), and the versions here are exactly what
[`dependencies.md`](dependencies.md) records.

### Policy hooks

Every fs, git, and exec call asks one function, `RunnerPolicy` (apps/runner/src/policy.ts), before
it acts; a refusal is JSON-RPC `-32451` on the wire and a 451 `policy_violation` from the api. The
built-in rules are the floor a runner enforces on its own (spec §5.7's examples):

- `exec`: denied command patterns (`rm -rf` on `/`, `~`, `..`, `.`, or `*`; `git push --force`/`-f`/
  `--delete`/`+ref`; `npm|pnpm|yarn|bun|cargo publish`, `gem push`, `twine upload`, `docker push`;
  `mkfs`, `dd if=`, `shutdown|reboot|halt|poweroff`, the fork bomb, `chmod 777 /`), and `cwd`
  inside the projects root (`perch runner connect` sets `execAnywhere` on your own machine).
- `fs.write`: `.git/**` is read-only through the file methods; git.* manages it.
- `git.push`: `protectedBranches` refuse a push before it starts (none by default).

`runnerPolicy(rules)` builds one from `PolicyRules` (`deniedCommands`, `protectedBranches`,
`readOnlyPaths`, `execAnywhere`); the `.perch/policy.yaml` evaluator of task 2.11 layers workspace
and project rules on the same hook. Design notes: ADR-0070.
