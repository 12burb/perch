/**
 * Stages the `perch-bot-sdk` npm package from `packages/bot-sdk` (spec §7.3; task 2.19's
 * "bot-sdk published"). The source is one dependency-free file, so the package is one bundled ESM
 * module, its types, a README and the licence — small enough that `npx`-ing a bot is instant.
 *
 *   bun scripts/build-bot-sdk.ts [--out dist/bot-sdk] [--version 1.2.3]
 *
 * The name is unscoped, like `perch-dev`: an npm scope needs an org, and nothing about the SDK
 * should wait on one.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const NPM_NAME = "perch-bot-sdk";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: "string" }, version: { type: "string" } },
  strict: true,
});

const pkgDir = join(root, "packages", "bot-sdk");
const out = resolve(values.out ?? join(root, "dist", "bot-sdk"));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version?: string;
};
const version = values.version ?? rootPkg.version ?? "0.0.0";

function run(cmd: string[], cwd = root): void {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${proc.exitCode}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The module itself: bundled for a browser-ish target, because a bot may run in one and the SDK
// only ever touches `fetch`, `WebSocket`, `FormData` and `URL`.
run([
  "bun",
  "build",
  "--target=browser",
  "--format=esm",
  join(pkgDir, "src", "index.ts"),
  "--outfile",
  join(out, "index.js"),
]);

// The types, straight from the source: one `tsc` pass into the same directory.
run([
  "bunx",
  "tsc",
  // The package's own tsconfig is not for this: one file in, one .d.ts out.
  "--ignoreConfig",
  "--emitDeclarationOnly",
  "--declaration",
  "--module",
  "esnext",
  "--moduleResolution",
  "bundler",
  "--target",
  "es2023",
  "--strict",
  "--skipLibCheck",
  "--outDir",
  out,
  join(pkgDir, "src", "index.ts"),
]);

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: NPM_NAME,
      version,
      description:
        "Write a Perch bot: the Bot API over HTTP and socket mode, with no dependencies.",
      license: "MIT",
      repository: {
        type: "git",
        url: "https://github.com/12burb/perch.git",
        directory: "packages/bot-sdk",
      },
      homepage: "https://github.com/12burb/perch/blob/main/docs/bot-api.md",
      keywords: ["perch", "bot", "chatops", "agent", "sdk"],
      type: "module",
      main: "./index.js",
      types: "./index.d.ts",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      sideEffects: false,
      files: ["index.js", "index.d.ts", "README.md", "LICENSE"],
    },
    null,
    2,
  )}\n`,
);
cpSync(join(pkgDir, "README.md"), join(out, "README.md"));
cpSync(join(pkgDir, "LICENSE"), join(out, "LICENSE"));

for (const file of ["index.js", "index.d.ts", "package.json", "README.md", "LICENSE"]) {
  if (!existsSync(join(out, file))) throw new Error(`${file} is missing from ${out}`);
}
console.log(`${NPM_NAME}@${version} staged in ${out}`);
