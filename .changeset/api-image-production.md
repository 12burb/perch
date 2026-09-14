---
"@perch/api": patch
---

The api image ships a production-only runtime tree: the api workspace, the packages it links, and the
web build, with no dev tools, spike dependencies, or native build binaries, on a base image with Debian
security updates applied. Spike packages declare their libraries as devDependencies.
