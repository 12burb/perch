// @perch/ui — Tokens, themes, shadcn base, and the Perch components (spec §4). MIT.
//
// A component that carries an i18n fragment stays off this barrel and behind its own subpath
// (`@perch/ui/blocks`, `/session`, `/diff`), so the fragment's strings load with the chunk that
// needs them rather than with the first paint (ADR-0085). `@perch/ui/virtual-list` is off it for
// the same reason with a library instead of strings: the virtualizer belongs to the screens that
// have long lists, not to the first paint (ADR-0113).
export const packageName = "@perch/ui";

export { EditorGroup, type EditorGroupProps, type EditorTab } from "./components/editor-group.tsx";
export {
  Dialog,
  type DialogProps,
  Sheet,
  Tooltip,
  TooltipProvider,
} from "./components/overlays.tsx";
export {
  Avatar,
  Badge,
  BotBadge,
  Button,
  type ButtonProps,
  badgeVariants,
  buttonVariants,
  Field,
  IconButton,
  Input,
  Kbd,
  Label,
  Separator,
  Textarea,
  VisuallyHidden,
} from "./components/primitives.tsx";
export { getLocale, type Locale, type MessageKey, setLocale, t } from "./i18n/index.ts";
export {
  CommandPalette,
  type PaletteCommand,
  useCommandPaletteShortcut,
} from "./shell/command-palette.tsx";
export {
  Composer,
  type ComposerProps,
  type MentionQuery,
  type Suggestion,
} from "./shell/composer.tsx";
export { Drawer, type DrawerTab } from "./shell/drawer.tsx";
export { EmptyState } from "./shell/empty-state.tsx";
export { type MobileTab, MobileTabBar } from "./shell/mobile-tab-bar.tsx";
export { Panel } from "./shell/panel.tsx";
export { Peek } from "./shell/peek.tsx";
export { RAIL_MODES, Rail, type RailMode, type RailProps } from "./shell/rail.tsx";
export {
  MOBILE_QUERY,
  Shell,
  type ShellProps,
  type ShellState,
  ShellToggles,
  useIsMobile,
  useShellShortcuts,
} from "./shell/shell.tsx";
export { Sidebar, SidebarItem, SidebarSection } from "./shell/sidebar.tsx";
export {
  applyTheme,
  type Density,
  getTheme,
  initTheme,
  type ThemeName,
  type ThemeState,
  useTheme,
} from "./theme.ts";
export { cn } from "./utils.ts";
