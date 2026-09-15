# Previews: watching it run

A dev server on a runner is not much use if nobody can see it. A **preview** is Perch standing in
front of one: your browser talks to Perch, Perch talks to the port, and what comes back is the dev
server's own bytes (spec §5.6; task 1.18, ADR-0084).

## Where it lives

Code mode → **Previews** in the sidebar lists every port the open project's runner is serving.
Clicking one puts the Preview in main, where the editor usually is; **⌘⇧P** toggles it.

The tab gives an iframe the chrome it does not have: an address bar for the path, back and forward
over the addresses you visited, reload, viewport presets (phone, tablet, desktop, and rotate) so you
can see the phone layout without a phone, a link out to a real tab, and **Share**.

A port the project's own config names — `preview.port` in `.perch/project.json` — is marked with a
star and opens on `preview.path`. Nothing running yet? The tab tells you the `preview.command` to
run; the terminal is one **⌘J** away.

## Two shapes of URL

| Mode | URL | When |
|---|---|---|
| **Wildcard** | `https://<port>--<workspace>.<PERCH_PREVIEW_DOMAIN>` | `PERCH_PREVIEW_DOMAIN` is set and the workspace's slug fits in a hostname |
| **Path** | `<your Perch>/p/<workspace>/<port>/` | always |

Wildcard mode gives each port an origin of its own, which is what a dev server expects: its cookies,
its storage, its service worker, and — because the browser's own address is the preview's — its
**HMR socket works with no configuration at all**. Path mode needs no DNS and no certificate, which
is why it is the fallback and the default in laptop mode; the trade is that a dev server's HMR
client dials the root of Perch's origin rather than the preview's, so a project that wants hot
reload through path mode has to tell its dev server the prefix (Vite: `base` or `server.hmr.path`).

Set `PERCH_PREVIEW_DOMAIN` to a name **under Perch's own domain** — `perch.example.com` and
`*.perch.example.com`, or a `preview.example.com` beside an `app.example.com`. Then the preview is
same-site with Perch, which is what keeps you signed in inside the frame. `perch init` writes the
Caddyfile with the wildcard block and the DNS challenge when you give it a preview domain.

## Who gets in

A preview is gated (spec §5.6). A member of the workspace is let in; anyone else is not. Because a
preview has an origin of its own, Perch's session cookie does not reach it, so the Preview tab hands
the frame a **ticket** — a short-lived token, good for one member, one workspace and one port, that
becomes a cookie on the preview's origin and expires within the quarter hour.

The proxy reaches only a port a workspace's own runner reported listening, and never 22, 5432, 6379
and their neighbours: a preview is a dev server, not a tunnel to the database.

## Share links

**Share** mints a link anyone can open, for one port, until it expires — an hour, a day, thirty days
at most. The link is shown once, because Perch keeps only a hash of it. **Revoke** ends it
immediately, for everyone holding it.

A shared preview is the dev server's page and nothing else: no inspector is injected, ever (§5.6).

## Local runners

A laptop connected with `perch runner connect` is behind whatever network it is behind, so the api
has no address to proxy to. Its previews travel the other way instead: back through the WebSocket
the runner already opened (spec §7.6 `http.open`). The api asks the runner to make the request,
the runner reaches its own loopback, and the answer — or a whole WebSocket, relayed frame for
frame — comes back on a stream. HMR works the same as anywhere else, which is what lets you watch
a laptop's dev server from a phone.

Nothing about this is visible in the tab: the same URLs, the same share links. The only difference
is which way the bytes go. A runner that shares a network with the api is still reached directly,
because that is faster and there is no reason not to.

On a stream, the side that sent the last frame never hangs up (ADR-0091): the runner says `end` and
the api, which is reading, closes. A client socket discards whatever it has not written yet when it
is closed, so a runner that hung up on its own answer would deliver a page with its tail missing and
nothing to say so. For the same reason a stream that closes mid-answer is a failed request, not a
short page.

## The inspector

⌘⇧C, click-to-source, the Elements tree, the console and failed-requests strip, and screenshots live
in [the inspector](./inspector.md). A share link never carries any of it (§5.6).

## Not here yet

Direct tweaks from the panel, the agent's own Playwright eyes, and preflight visual smoke — Phase 3.
