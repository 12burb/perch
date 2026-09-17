---
"@perch/api": patch
---

The docs site has somewhere to live: `docs.yml` publishes it to GitHub Pages on every released
version, or by hand. It needs no secret — Pages set to "GitHub Actions" and a `DOCS_PAGES=on`
repository variable — and until those are set the job is skipped rather than failed, so a release
does not go red over a site nobody has turned on yet.
