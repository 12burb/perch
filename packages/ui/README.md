# @perch/ui

Tokens, themes, the shadcn-style base, and the Perch shell components (spec §4). MIT licensed.

| Export | What |
|---|---|
| `@perch/ui` | everything below plus `cn()` and the i18n helpers |
| `@perch/ui/i18n` | `t(key, params)`, `setLocale`, `getLocale`; catalog in `src/i18n/en.json` |
| `@perch/ui/tokens.css` | `--perch-*` tokens (dark-first + light via `prefers-color-scheme` or `data-theme`, `data-density="compact"`, reduced motion) and the Tailwind v4 `@theme inline` mapping (`bg-surface`, `text-fg-muted`, `border-border`, `w-rail`, `min-h-touch`, …) |
| `@perch/ui/styles.css` | Tailwind + tokens for hosts without their own build (the CT harness) |

Components: `Shell` (rail | sidebar | main | panel + drawer; phone: main + `MobileTabBar`, sidebar and
panel as sheets), `Rail`, `Sidebar`/`SidebarSection`/`SidebarItem`, `Panel`, `Drawer`, `Peek`,
`CommandPalette` + `useCommandPaletteShortcut` (⌘K), `Composer` (Enter sends, Shift+Enter newline, Esc
stops, drafts persist), `EmptyState`, and the base: `Button`, `IconButton`, `Input`, `Textarea`, `Label`,
`Field`, `Separator`, `Badge`, `BotBadge`, `Avatar`, `Kbd`, `Tooltip`, `Dialog`, `Sheet`. Theme and density:
`useTheme()`, `applyTheme()`, `initTheme()`.

Apps that run their own Tailwind build add `@source "../../../packages/ui/src";` next to
`@import "@perch/ui/tokens.css";` (Tailwind v4 skips linked packages).

```sh
bun run --filter @perch/ui typecheck
bun run --filter @perch/ui test        # i18n unit tests
bun run ct                             # Playwright component tests (src/**/*.ct.tsx) at 1440 px and 390 px, axe on every one
```

Every user-facing string goes through `t("key")` (spec §9.1). Every component has ARIA roles and labels,
visible focus, 44 px touch targets on phones, and is keyboard complete (ADR-0055).
