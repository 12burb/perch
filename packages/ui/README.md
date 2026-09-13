# @perch/ui

Tokens, themes, shadcn base, and the Perch components (spec §4). MIT licensed.

| Export | What |
|---|---|
| `@perch/ui` | `cn()` (clsx + tailwind-merge) and the i18n helpers |
| `@perch/ui/i18n` | `t(key, params)`, `setLocale`, `getLocale`; catalog in `src/i18n/en.json` |
| `@perch/ui/tokens.css` | design tokens (`--perch-*`), light/dark via `prefers-color-scheme` or `data-theme`, and the Tailwind v4 `@theme inline` mapping (`bg-bg`, `text-fg`, `border-border`, `bg-accent`, …) |

Every user-facing string in every app goes through `t("key")` even with only `en` shipped (spec §9.1);
placeholders are `{name}`. The component set (Shell, Rail, Sidebar, Panel, Drawer, CommandPalette, Peek,
Composer) with Playwright component tests and axe arrives with task 0.11.
