# The inspector: pointing at the thing you mean

Open a project's **Preview** tab, press **Inspect** (or ⌘⇧C), and click something in the page. Perch
tells you what it is, where it came from, and lets you hand that to an agent — so "make this
primary" edits the right file instead of the one the agent guessed (spec §5.6; task 2.16).

## How an element knows where it came from

Add the dev plugin to the project you are previewing. It tags every JSX element with the file, line
and column it was written at, in development only:

```js
// vite.config.js
import { perchInspector } from "@perch/inspector/vite";
export default { plugins: [perchInspector()] };
```

```js
// next.config.js
import { withPerchInspector } from "@perch/inspector";
export default withPerchInspector({ /* your config */ });
```

```js
// webpack.config.js — the loader is the same one Next uses
module.exports = {
  module: { rules: [{ test: /\.(jsx|tsx)$/, exclude: /node_modules/, use: ["@perch/inspector/webpack"] }] },
};
```

Each element gains `data-perch-src="src/components/Button.tsx:42:7"`. Without the plugin the
inspector still works — it just describes the element by its place in the DOM instead of by file,
and the agent has more searching to do.

The transform is a scanner, not a parser: it finds the `<` that opens an element and puts one
attribute after the tag name, skipping anything ambiguous (ADR-0107). A tag it misses costs a source
link; a tag it got wrong would cost a build, so it only tags what it is sure of.

## What gets injected, and where

The preview proxy inserts a small script before `</head>` — but only for a page a **member of the
workspace** asked for through the Preview pane. A share link never carries it (§5.6): a shared
preview is the dev server's page and nothing else.

The script is nonce-bound: the proxy mints a nonce per response, the script signs every message with
it, and the pane only believes messages that came from the iframe it is showing. If the dev server
sets its own `Content-Security-Policy`, Perch adds that one nonce to it rather than relaxing the
rule.

## What you can do with a selection

- **Use as context** turns it into a chip on the session composer. The next turn carries "the button
  at src/components/Button.tsx:42:7 reading 'Subscribe'", and the chip is spent once it has ridden.
- The **Elements** tree lists the page's structure; hovering a row highlights it in the page.
- The **console and failed requests** strip collects what the page logged and every request that
  came back not-ok. **Send to agent** makes either one a chip.
- **Screenshot** asks the runner's own headless browser for a picture of the page. It becomes a file
  either way: attached to the next turn as a chip, or posted straight into a channel you pick.

A screenshot needs a browser on the runner. The hosted runner image ships one; a local runner uses
whatever is installed, and `PERCH_CHROMIUM` names one explicitly.

## Direct tweaks (task 3.21)

With an element selected, the panel gives you its **Text** and its **Classes**. Typing in either
changes the page as you type — the preview is a page, and changing a page is cheap. Nothing has been
written anywhere yet.

**Write to source** is the other half:

```
POST /api/workspaces/{ws}/projects/{p}/element-edit  {source, class_name?, text?}
  → {path, changed, diff}
```

It takes the element's own `data-perch-src`, so you never say which file or which line. That is what
makes it deterministic: there is no model, and no guess about which `<div className="p-2">` was
meant. Given the file and the position, it finds the opening tag and changes the one attribute or
the one piece of text it was asked to. The diff comes back with it, and the panel shows it.

**It refuses more than it attempts**, which is the point:

| It will not | Because |
|---|---|
| `className={cn(a, b)}` | that is an expression, not a list of classes to rewrite |
| text in an element holding anything but text | there is no one string to replace |
| text on `<img />` | nothing to put it in |
| a position the file has moved on from | it is not that element any more |
| text containing `<` or `{` | that is markup, not words |

Each refusal is a `422` carrying its reason, which is what the panel shows you instead. A refusal is
something you can work around — open the file, or ask the agent. A guess would be a wrong edit in
your repository.

An element written over several lines keeps its indentation: JSX collapses the whitespace either
way, and reflowing a file to change one word is a rude diff.

Without the dev plugin there is no `data-perch-src`, so there is nothing to write to and the button
is disabled. The tweak still shows in the page.

## The agent's eyes (task 3.21)

An agent working on a page should be able to look at it. While the project's **own** preview is
serving — the port `.perch/project.json` names, with something on it — every session on that project
is handed a Playwright MCP server, spawned on the runner beside the agent. It navigates, takes
accessibility snapshots, clicks and screenshots, and it does all of that where the page is.

It is spawned rather than served over HTTP, which is the one new shape in §7.6's `mcp_servers`: a
browser has to be on the runner, so there is nothing for the api to serve (ADR-0139). Nothing in
that server's configuration is a credential — it is a command line on a machine Perch does not own.

```
PERCH_PLAYWRIGHT_MCP="npx -y @playwright/mcp@0.0.41"
```

Unset means off, and that is the default. Which build of `@playwright/mcp` matches the browser in a
given runner image is that operator's decision; Perch pinning one on their behalf would be Perch
choosing a package manager and a network fetch inside somebody else's container.

"A preview is open" means the project's configured port specifically. Any-port-is-up would be wrong
twice over: a runner has other things listening, and Perch would not know which of them is the page.
A session with nothing to look at gets no browser — a process and a context window spent on nothing,
and an agent offered tools that cannot work is an agent that will try them.

## Not here yet

Preflight visual smoke is the rest of §5.6's Phase 3.
