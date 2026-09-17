# @perch/scripts

## 0.1.0

### Minor Changes

- 7845619: The docs are a site. `bun scripts/docs-site.ts --sync && cd docs/site && bun run build` turns every
  Markdown file under `docs/` into an Astro Starlight site with search — the Markdown stays the
  source, so nothing is written twice.
  
  The sidebar is generated from the files that exist and a test asserts every page is in it; every
  link between pages is resolved (anchors included) and a broken one fails `bun run check` and the
  build. CI builds the site on every push, and a release attaches `docs-site-<version>.tar.gz` with
  the version in its title.

### Patch Changes

- 591dca0: `bun run check` now parses every GitHub workflow. A workflow with a syntax error does not fail
  loudly — GitHub runs it anyway, names the run after the file instead of the workflow, and fails it —
  so the first sign of one is a red `main`.
