/**
 * Theme and density (spec §4): dark-first + light + system; compact/comfortable. Applied as
 * `data-theme` / `data-density` on <html>, remembered per browser.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

export type ThemeName = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";
export type ThemeState = { theme: ThemeName; density: Density };

const STORAGE_KEY = "perch.theme";
const listeners = new Set<() => void>();
let state: ThemeState = { theme: "system", density: "comfortable" };

function read(): ThemeState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    return {
      theme: parsed.theme === "dark" || parsed.theme === "light" ? parsed.theme : "system",
      density: parsed.density === "compact" ? "compact" : "comfortable",
    };
  } catch {
    return state;
  }
}

/** Writes the attributes the tokens respond to. Safe to call before React mounts (no flash). */
export function applyTheme(next: ThemeState): void {
  state = next;
  const root = globalThis.document?.documentElement;
  if (root) {
    if (next.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next.theme);
    if (next.density === "compact") root.setAttribute("data-density", "compact");
    else root.removeAttribute("data-density");
  }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: the choice lasts for the tab.
  }
  for (const listener of listeners) listener();
}

export function initTheme(): ThemeState {
  const initial = read();
  applyTheme(initial);
  return initial;
}

export function getTheme(): ThemeState {
  return state;
}

export function useTheme(): ThemeState & {
  setTheme: (theme: ThemeName) => void;
  setDensity: (density: Density) => void;
} {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!globalThis.document?.documentElement.hasAttribute("data-perch-theme-init")) {
      globalThis.document?.documentElement.setAttribute("data-perch-theme-init", "1");
      initTheme();
    }
  }, []);
  const setTheme = useCallback((theme: ThemeName) => applyTheme({ ...state, theme }), []);
  const setDensity = useCallback((density: Density) => applyTheme({ ...state, density }), []);
  return { ...current, setTheme, setDensity };
}
