# Accessibility

Perch is a place people work all day. Some of them do it without a mouse, at 200 % zoom, or with a
screen reader reading the part of the page that just changed. This page says what the project holds
itself to, what is checked automatically, and where the checks live — so the bar is a thing you can
run rather than a thing you can mean.

## The bar

- **Every screen passes [axe](https://github.com/dequelabs/axe-core)** with no violations, at both
  390 px and 1440 px.
- **Every flow can be driven by keyboard alone**: Tab, Shift+Tab, Enter, Space, the arrows, Escape
  and the shortcuts. No step needs a pointer.
- **Focus is never lost.** It goes into a dialog when one opens, and back to what opened it when it
  closes — and when nothing opened it, onto the page rather than onto `<body>`.
- **What changes is announced**, not only drawn: a live region carries it.

## What runs, and where

| Check | Where | Covers |
|---|---|---|
| axe on every screen | [`e2e/a11y.e2e.ts`](../e2e/a11y.e2e.ts) | Every route in `apps/web/src/routes`, at both viewports |
| The route list is complete | [`apps/web/test/screens.test.ts`](../apps/web/test/screens.test.ts) | A new route is audited or explained; no stale entries |
| Keyboard-only walkthrough | [`e2e/keyboard.e2e.ts`](../e2e/keyboard.e2e.ts) | Sign up, first workspace, palette, channel, message, mode switch — no `.click()` in the file |
| axe per component | `packages/ui/src/**/*.ct.tsx` | Each component in both themes, as it is built |

The sweep visits every screen in one signed-in session — with a channel and a project on it, so the
two detail routes have something to audit — then clears its cookies and visits the signed-out ones.
`SCREENS` in the spec lists what is audited and `NOT_SCREENS` lists what is not, each with a reason;
the unit test reads both against the routes on disk, so a route added next year arrives here without
anybody remembering to add it.

## Patterns this codebase uses

**The rail is a tablist with a roving tabindex.** Only the selected mode is in the Tab order; the
arrows move between the six, Home and End go to the ends, and moving selects (automatic activation,
because each mode is a route and arriving is the point). The handler travels on the tab props, so an
app that renders its tabs as links gets it too — see `packages/ui/src/shell/rail.tsx`. On a phone the
same modes are a bottom `nav` of buttons with `aria-current`, where each one is a Tab away.

**The command palette gives focus back.** It is opened from ⌘K and from buttons all over the app, so
there is no `Dialog.Trigger` for Radix to restore to. The palette remembers the last focused element
while it is closed, ignoring anything inside a dialog, and puts focus back once the close has
settled. When nothing had focus — ⌘K on a page nobody has tabbed into — focus lands on `<main>`
instead, or the next Tab would start the document over.

**A region that scrolls is focusable.** A keyboard has to be able to scroll what a thumb can, which
axe calls `scrollable-region-focusable`. The Work board's column strip carries `tabIndex={0}` and no
label, because a second landmark inside the board's own would be a violation of its own.

**Every screen has one `<main id="main">`** and one `<h1>`. The shell provides both.

## Adding a screen

1. Add the route.
2. Add it to `SCREENS` in `e2e/a11y.e2e.ts` with a `settled` check that waits for the real content,
   so axe never audits a spinner. If it is not a screen — a layout, a redirect — add it to
   `NOT_SCREENS` with a reason. `bun test apps/web/test/screens.test.ts` tells you which.
3. Run `bun run e2e e2e/a11y.e2e.ts` and fix what it finds.

## Reporting something

An accessibility bug is a bug: open an issue. If you use an assistive technology and something is
unusable, say which one and what it said — that is usually the whole diagnosis.
