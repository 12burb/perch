// @perch/ui — Tokens, themes, shadcn base, and the Perch components (spec §4). MIT.
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
export { Composer, type ComposerProps } from "./shell/composer.tsx";
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
