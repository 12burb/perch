// @ts-check
/**
 * The Perch docs site (task 4.7). Its pages are written by `scripts/docs-site.ts` from the
 * Markdown in `docs/`, which is where they are edited; nothing here is hand-authored except this
 * configuration. Search is Starlight's own (Pagefind, built at build time, no service).
 */
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import sidebar from "./src/sidebar.json" with { type: "json" };

const base = process.env.PERCH_DOCS_BASE ?? "/";
const version = process.env.PERCH_DOCS_VERSION ?? "";

export default defineConfig({
  site: process.env.PERCH_DOCS_SITE ?? "https://12burb.github.io",
  base,
  trailingSlash: "always",
  integrations: [
    starlight({
      title: version ? `Perch ${version}` : "Perch",
      description:
        "Perch: a self-hosted agentic workspace. IDE, team chat, bots, connections, model gateway.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/12burb/perch" }],
      editLink: { baseUrl: "https://github.com/12burb/perch/edit/main/docs/" },
      sidebar,
      lastUpdated: false,
      pagination: false,
      customCss: ["./src/perch.css"],
    }),
  ],
});
