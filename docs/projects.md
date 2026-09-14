# Projects

A project (spec §5.1, task 1.4) is a row in a workspace and a directory on a runner. The row exists
the moment you create it; the directory is set up asynchronously on a runner the workspace may use,
and the row's `status` follows: `pending` → `setting_up` → `ready` or `error`, each step a
`project.updated` event on the workspace topic (the Code page updates live).

## Creating one

From Code mode ("New project") or the API:

| Source | Route | What happens on the runner |
|---|---|---|
| Empty | `POST /api/workspaces/{ws}/projects` `{name, key?, default_branch?}` | `git init --initial-branch <branch>` (default `main`) |
| Upload | `POST …/projects` `{name, source: "upload"}`, then `POST …/projects/{p}/files` (multipart) | `git init`, then each part is written at the path its filename carries |
| Clone | `POST …/projects/clone` `{name, key?, repo_url, branch?, auth?}` | `git clone`, with credentials through git's own helpers (below) |

`key` is the project's slug in the workspace (`[a-z0-9-]`, unique, case-insensitive); it is derived
from the name when omitted. Every route needs `projects.read` / `projects.create` / `projects.update`
(all roles) or `projects.delete` (owner, admin).

### Clone credentials

- **Public** repositories need no `auth`.
- **Token** (`auth: {kind: "token", token, username?}`, for `https://` remotes): the token travels
  from the request to the runner over the control channel and reaches git through a credential
  helper that reads it from the environment. It is never stored, never logged, never on a command
  line, and never in the clone's `.git/config`. The username defaults to `x-access-token` (GitHub;
  GitLab and others accept any username with a token).
- **Deploy key** (`auth: {kind: "deploy_key"}`, for `ssh://` and `git@host:owner/repo.git` remotes):
  every workspace has one Ed25519 key, minted on first read of `GET /api/workspaces/{ws}/deploy-key`.
  Add the public key to the repository's deploy keys (read access is enough), then clone. The private
  half is vault-encrypted at rest and decrypted only to hand the runner its key file for the clone
  (`GIT_SSH_COMMAND` with `BatchMode=yes`; the file is deleted afterwards). Admins rotate it with
  `POST …/deploy-key/rotate`; the old key stops working at once.

A `repo_url` with embedded credentials (`https://user:token@…`), a `file://` URL, or a local path is
refused with 422.

## What the runner reads back

After the directory exists the runner reads two files and reports them; the api validates and
applies them:

- `.perch/project.json` is validated against the config schema (`packages/db` `projectConfigSchema`:
  `engine`, `modelProfile`, `permissionPolicy`, `run`, `envFile`, `preview`, `background`). A valid
  file becomes `config` and sets the project's defaults (`default_engine` from `engine`). An invalid
  or unparsable file leaves `config` at `{}` and explains why in `config_error`.
- `devcontainer.json` (`.devcontainer/devcontainer.json` or `.devcontainer.json`, JSONC: comments
  and trailing commas allowed) is stored in `devcontainer`. Its `postCreateCommand` (string or
  array) runs once after a clone or an upload with a 10-minute budget; a non-zero exit is reported in
  `status_message` and the project is still `ready`. The image and features it names are honored
  when the supervisor builds per-project images (later task).

`head` is the checkout's commit and `default_branch` the branch git checked out (a clone's default
branch, or the branch you asked for).

## Where the directory lives

`<projects root>/<workspace id>/<project id>`:

| Runner | Root |
|---|---|
| Hosted (the runner image) | `/data/projects`, the compose `projects` volume mirrored into every runner container |
| Laptop mode (`perch dev`, the desktop app) | `<data dir>/projects` (`~/.perch/projects`) |
| Your own machine (`perch runner connect`) | `~/.perch/projects`, or `PERCH_PROJECTS_DIR` |

Deleting a project (`DELETE …/projects/{p}`) removes the row and, best effort, the directory on the
runner that holds it.

## Which runner

The api picks a connected runner the member may use: the workspace's own hosted runner first, then
the shared or in-process one, then the member's own machines (a local runner serves only its owner).
With none connected it asks the supervisor for one (`supervisor.ensure`) and waits up to two
minutes before marking the project `error` ("no runner is available").
