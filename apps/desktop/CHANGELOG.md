# @perch/desktop

## 0.1.0

### Minor Changes

- The first downloadable release: `perch` binaries for Linux (x64, arm64), macOS (arm64, x64), and Windows
  (x64) with the web app embedded, and the `perch-desktop` app for Linux, macOS, and Windows, all built and
  attached to the GitHub release by the release workflow.

### Patch Changes

- bb09a5c: The Perch desktop app: `perch-desktop` runs laptop mode (api, web, and the in-process runner on PGlite
  under `~/.perch`) in a native window on macOS, Windows, and Linux, on a fixed localhost port so sign-ins
  survive restarts, attaches to a Perch already running there, and opens a team instance with `--url`.
  `perch dev` now shares its boot with the app (`@perch/cli/laptop`).
- Updated dependencies [b7d9c3a]
- Updated dependencies [ae3e4ab]
- Updated dependencies [bb09a5c]
- Updated dependencies
- Updated dependencies [45c4eee]
- Updated dependencies [3ab9ae7]
  - @perch/cli@0.1.0
