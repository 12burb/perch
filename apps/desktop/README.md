# @perch/desktop

The Perch desktop app: laptop mode (api + web + the in-process runner on PGlite under `~/.perch`) in a
native window on macOS, Windows, and Linux. One binary, `perch-desktop`, built per platform by
`scripts/build-desktop.ts`; docs in `docs/desktop.md`; the design in ADR-0063.

```sh
bun apps/desktop/src/index.ts            # from source (needs a web build)
bun apps/desktop/src/index.ts --check    # loads the platform webview and exits
bun apps/desktop/src/index.ts --url https://perch.example.com
```
