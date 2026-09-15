/**
 * The dev plugins (spec §5.6 "@perch/inspector dev plugin (Vite, Next, … Webpack/Rspack)"; task
 * 2.16). Each one is the same transform wired into a different build: tag JSX with where it came
 * from, in development only, in the project's own files only.
 *
 * Nothing here imports Vite, Next or webpack. A plugin is a plain object with the hooks those tools
 * call, so `@perch/inspector` has no dependencies and cannot drag a second copy of anybody's
 * toolchain into a project (ADR-0107).
 */
import { relative } from "node:path";
import { taggableFile, tagSource } from "./tag.ts";

export type InspectorOptions = {
  /** The project root, so the attribute carries a path an agent can open. */
  root?: string;
  /** Off in a production build by default; `true` forces it on. */
  enabled?: boolean;
};

/** The path as the agent should see it: relative to the project, forward slashes, no query. */
export function sourcePath(id: string, root?: string): string {
  const path = (id.split("?")[0] ?? "").replace(/\\/g, "/");
  if (!root) return path.replace(/^\/+/, "");
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel.startsWith("..") ? path.replace(/^\/+/, "") : rel;
}

/** The transform itself, for a build tool that only wants a function. */
export function transformSource(
  code: string,
  id: string,
  options: InspectorOptions = {},
): string | null {
  if (!taggableFile(id)) return null;
  const tagged = tagSource(code, { file: sourcePath(id, options.root) });
  return tagged.tagged > 0 ? tagged.code : null;
}

/** What Vite calls a plugin: a name, when to run, and one transform. */
export type VitePluginLike = {
  name: string;
  enforce: "pre";
  apply: "serve";
  configResolved(config: { root?: string }): void;
  transform(code: string, id: string): { code: string; map: null } | null;
};

/**
 * `perchInspector()` in a project's vite.config. `apply: "serve"` keeps it out of the production
 * build, which is what §5.6 means by a dev plugin: nothing shipped to anybody's users.
 */
export function perchInspector(options: InspectorOptions = {}): VitePluginLike {
  let root = options.root;
  return {
    name: "perch-inspector",
    enforce: "pre",
    apply: "serve",
    configResolved(config) {
      if (!options.root && config.root) root = config.root;
    },
    transform(code, id) {
      const out = transformSource(code, id, { ...options, ...(root ? { root } : {}) });
      return out === null ? null : { code: out, map: null };
    },
  };
}

/** What webpack calls a loader: `this.resourcePath`, and the source in and out. */
export type LoaderContext = { resourcePath: string; rootContext?: string };

export function perchInspectorLoader(
  this: LoaderContext,
  source: string,
  options: InspectorOptions = {},
): string {
  const root = options.root ?? this.rootContext;
  return (
    transformSource(source, this.resourcePath, { ...options, ...(root ? { root } : {}) }) ?? source
  );
}

type WebpackRule = { test: RegExp; exclude: RegExp; use: { loader: string }[] };
type WebpackConfig = { module?: { rules?: unknown[] } };

/**
 * The webpack half, which is also the Next half: Next's `webpack(config)` hook is webpack's config.
 * The loader is named by its module path rather than passed as a function, because webpack resolves
 * loaders by request and Next serializes its config.
 */
export function withPerchInspectorWebpack(config: WebpackConfig, loader: string): WebpackConfig {
  const rule: WebpackRule = {
    test: /\.(jsx|tsx)$/,
    exclude: /node_modules/,
    use: [{ loader }],
  };
  const module = config.module ?? {};
  return { ...config, module: { ...module, rules: [...(module.rules ?? []), rule] } };
}

type NextConfig = {
  webpack?: (config: WebpackConfig, context: { dev: boolean }) => WebpackConfig;
};

/**
 * `withPerchInspector(nextConfig)` in next.config. Development only: a production build of a Next
 * app must be the app, not the app with Perch's attributes in it.
 */
export function withPerchInspector(
  nextConfig: NextConfig = {},
  loader = "@perch/inspector/webpack",
): NextConfig {
  return {
    ...nextConfig,
    webpack(config, context) {
      const base = nextConfig.webpack ? nextConfig.webpack(config, context) : config;
      return context.dev ? withPerchInspectorWebpack(base, loader) : base;
    },
  };
}
