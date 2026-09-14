# The terminal

Code mode's drawer (⌘J, or **Toggle drawer**) holds a terminal: a shell on the project's runner,
per person, that survives a reload, a closed drawer, and a dropped connection. Spec §5.1 (terminal),
§7.6 (`pty.*`, stream sockets); task 1.7; design notes in ADR-0073.

## What you get

- A shell in the project directory, as you: `PERCH_USER` is your user id, `HOME` is your own home
  on a hosted runner (`/data/homes/<user>`), `PERCH=1` marks the environment, `TERM` is
  `xterm-256color`. The official CLIs in the runner image (Claude Code, Codex, Gemini CLI, Hermes,
  OpenCode) run here under your own login (spec §3.6, lane C).
- **Persistence.** On a machine with tmux the shell runs inside a tmux session named for you and the
  directory (`perch-<12 hex>`), so the same person opening the same project gets the same session
  back, even after the runner process restarts. Without tmux (Windows, a bare laptop) the runner
  keeps the shell for ten minutes after the drawer disconnects.
- **Reload keeps the shell.** The browser remembers the shell's `pty_id` per project (session
  storage); reopening the drawer or reloading the page reattaches to it and replays the last
  64 KiB of output. **New shell** discards it; **Reconnect** appears after a dropped connection.
- **File paths are links.** A path printed in the output (`src/app.ts`, `./notes.txt:12`,
  `packages/ui/src/x.tsx:3:7`) underlines on hover and opens in the editor on click, at the line when
  one was printed. URLs open in a new tab.
- Resizing the drawer resizes the shell, and the drawer is a labelled region
  (`Terminal for <project>`) with a status line for screen readers.

## How it works

```
browser ──ws /api/workspaces/{ws}/projects/{p}/terminal──▶ api ──JSON-RPC pty.open──▶ runner
                                                            ◀──ws /api/runner/stream/{token}──┘
```

1. The api authorizes `projects.update` on the project, picks its runner (`projectRunnerLink`, 409
   when the project is not ready or its runner is offline), and calls `pty.open {cols, rows, cwd,
   user, pty_id?}` (the cwd is `<workspace>/<project>` under the runner's projects root).
2. The runner answers `{stream_token, pty_id, reattached}` and opens a data socket at
   `/api/runner/stream/{stream_token}` with its connect token as the bearer; the api pairs it with
   the waiting terminal within 15 s (the token is single-use and expires). In laptop mode the
   in-process runner pairs the two ends in memory.
3. Frames on the browser socket: to the api `{t:"i", d}` (input) and `{t:"r", cols, rows}`; from the
   api `{t:"open", pty_id, reattached}`, `{t:"o", d}` (output), `{t:"x"}` (the shell ended), and
   `{t:"e", message, code?}` (a failure; the socket closes).
4. When the browser socket closes the api closes its end of the stream; the runner keeps the shell
   for the grace period and replays scrollback to the next stream. Terminal query sequences (device
   attributes, cursor position, colour queries) are stripped from the replay so a reattaching xterm
   does not answer them into the shell as keystrokes.

Query parameters: `cols` and `rows` (2–500 / 2–300, default 80×24) and `pty_id`. Unknown or exited
`pty_id`s start a fresh shell. Closing the drawer does not kill the shell; `pty.close` is used when a
person asks for a new one.

## Security

- The shell's environment is the runner's minus every `PERCH_*` variable: the runner's connect
  token, the master key, and session secrets never reach a terminal or anything started from it
  (AGENTS.md §1.6). Your own variables on a local runner (an `OPENAI_API_KEY` you exported) stay.
- A local runner (`perch runner connect`) only opens shells for its owner; the api refuses the
  terminal route to anyone without `projects.update` in the workspace (a stranger gets 404).
- The runner's data socket is authenticated with the runner's connect token like the control
  channel; a stream token pairs one socket with one terminal, once.
- What you type is yours: the policy hook's denied command patterns bound `exec` (what agents
  run), not a person at their own shell.

## Tests

- `apps/runner/test/pty.test.ts`: open, talk, resize, detach, reattach with scrollback, close, exit;
  bad cwd, unknown token; tmux persistence (the same session comes back); the environment.
- `apps/api/test/terminal.test.ts`: the route in laptop mode (reattach after a reconnect, resize,
  exit → `x`), a stranger gets 404, a local runner over a real stream socket.
- `e2e/terminal.e2e.ts`: the acceptance criterion at both viewports — run a command, reload, see the
  same shell and its scrollback, click a printed path and land in the editor; axe clean.

Docs: [`runners.md`](runners.md) (the `pty.*` methods and the stream endpoint),
[`editor.md`](editor.md).
