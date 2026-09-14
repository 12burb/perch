/**
 * PGlite's runtime files, embedded (spec §2: one binary; ADR-0060). `with { type: "file" }` imports
 * resolve to the real files when running from source and to files inside the executable after
 * `bun build --compile`, so the same code serves both. The wasm modules and the filesystem bundle are
 * handed to PGlite directly; the extension tarballs are copied once to a cache directory because
 * PGlite reads them through node:fs, which cannot open files inside the executable.
 */
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@electric-sql/pglite";
import type { PgliteRuntime } from "@perch/db";
import citextTar from "../node_modules/@electric-sql/pglite/dist/citext.tar.gz" with {
  type: "file",
};
import initdbWasm from "../node_modules/@electric-sql/pglite/dist/initdb.wasm" with {
  type: "file",
};
import pgliteData from "../node_modules/@electric-sql/pglite/dist/pglite.data" with {
  type: "file",
};
import pgliteWasm from "../node_modules/@electric-sql/pglite/dist/pglite.wasm" with {
  type: "file",
};
import vectorTar from "../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz" with {
  type: "file",
};

let cached: Promise<PgliteRuntime> | null = null;

async function materialize(embeddedPath: string, name: string): Promise<string> {
  const dir = join(tmpdir(), `perch-pglite-${Bun.version}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  if (!existsSync(target)) await Bun.write(target, Bun.file(embeddedPath));
  return target;
}

function bundled(name: string, path: string, passEmscripten = false): Extension {
  return {
    name,
    setup: async (_pg, emscriptenOpts: unknown) => ({
      ...(passEmscripten ? { emscriptenOpts } : {}),
      bundlePath: pathToFileURL(path),
    }),
  };
}

/** Compiles the wasm modules once and hands PGlite every file it would otherwise look up on disk. */
export function pgliteRuntime(): Promise<PgliteRuntime> {
  cached ??= (async () => {
    const [pgliteWasmModule, initdbWasmModule, data, vectorPath, citextPath] = await Promise.all([
      WebAssembly.compile(await Bun.file(pgliteWasm).arrayBuffer()),
      WebAssembly.compile(await Bun.file(initdbWasm).arrayBuffer()),
      Bun.file(pgliteData).arrayBuffer(),
      materialize(vectorTar, "vector.tar.gz"),
      materialize(citextTar, "citext.tar.gz"),
    ]);
    return {
      pgliteWasmModule,
      initdbWasmModule,
      fsBundle: new Blob([data]),
      extensions: {
        vector: bundled("vector", vectorPath, true),
        citext: bundled("citext", citextPath),
      },
    };
  })();
  return cached;
}
