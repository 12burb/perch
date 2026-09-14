import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The router plugin must run before React so routeTree.gen.ts exists when the app is compiled.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3000", ws: true } },
  },
  // The manifest lets scripts/perf-budget.ts tell route chunks from on-demand library packs.
  build: { sourcemap: true, manifest: true },
});
