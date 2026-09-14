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

The supervisor (task 1.2) mints the token, starts the container with these variables, and watches
`runner.online`. The agent reconnects with jittered backoff (1 s to 30 s) when the api restarts; a
refused upgrade three times in a row ends the process with exit code 1 so the supervisor sees it.

## The supervisor (hosted runners)

The `supervisor` entrypoint of the api image (`docker compose` service `supervisor`, the only service
that mounts the Docker socket) runs the hosted runners:

- **On demand.** The api enqueues `supervisor.ensure {workspaceId}` (jobs queue); the supervisor creates
  one container per workspace from `PERCH_RUNNER_IMAGE` with the limits of `PERCH_RUNNER_LIMITS`
  (`cpus=2,memory=4g,pids=512`), the homes and projects volumes at `/data/homes` and `/data/projects`,
  a fresh connect token, and the labels `dev.perch.role=runner`, `dev.perch.workspace=<id>`,
  `dev.perch.runner=<runner id>`. A workspace whose container is already running gets nothing new.
- **Shared mode.** `PERCH_RUNNER_MODE=shared` runs one container for the whole instance, on a runner row
  without a workspace, which every workspace may use.
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
