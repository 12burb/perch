// The component-test harness: the package stylesheet (Tailwind + tokens) around every mounted component.
import { beforeMount } from "@playwright/experimental-ct-react/hooks";
import "../src/styles.css";

export type HooksConfig = { theme?: "dark" | "light"; density?: "compact" | "comfortable" };

beforeMount<HooksConfig>(async ({ hooksConfig }) => {
  const root = document.documentElement;
  if (hooksConfig?.theme) root.setAttribute("data-theme", hooksConfig.theme);
  else root.removeAttribute("data-theme");
  if (hooksConfig?.density === "compact") root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
});
