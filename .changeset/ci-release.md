---
"@perch/cli": patch
"@perch/api": patch
---

CI and releases (task 0.15): the pull-request pipeline (Biome, typecheck, unit tests on PGlite and
Postgres, SDK drift, perf budgets, component tests with axe, Playwright from the setup wizard, the
laptop smoke on Linux/macOS/Windows, the compose smoke with Trivy), weekly CodeQL, the changesets
version pull request, and the tag release: multi-arch images on GHCR signed with cosign with attested
SBOMs, perch binaries per platform with the web app embedded, and the `perch-dev` npm package.
