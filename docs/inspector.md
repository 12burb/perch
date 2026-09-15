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

## Not here yet

Direct tweaks (edit text, classes and CSS in the panel, written back to source), the agent's own
Playwright eyes, and preflight visual smoke are Phase 3 (spec §5.6).
