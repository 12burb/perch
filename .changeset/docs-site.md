---
"@perch/scripts": minor
---

The docs are a site. `bun scripts/docs-site.ts --sync && cd docs/site && bun run build` turns every
Markdown file under `docs/` into an Astro Starlight site with search — the Markdown stays the
source, so nothing is written twice.

The sidebar is generated from the files that exist and a test asserts every page is in it; every
link between pages is resolved (anchors included) and a broken one fails `bun run check` and the
build. CI builds the site on every push, and a release attaches `docs-site-<version>.tar.gz` with
the version in its title.
