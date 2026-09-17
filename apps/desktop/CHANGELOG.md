# @perch/desktop

## 0.1.2

### Patch Changes

- Updated dependencies [03efd44]
- Updated dependencies [f519b64]
- Updated dependencies [8362875]
- Updated dependencies [e0fa6ce]
- Updated dependencies [1d5af02]
- Updated dependencies [7ccdff3]
- Updated dependencies [818fb81]
  - @perch/cli@0.3.0

## 0.1.1

### Patch Changes

- d003f3b: The desktop test suite no longer fails on Windows because the operating system was still holding a
  temp directory it had finished with.
- Updated dependencies [2285bef]
- Updated dependencies [de84546]
- Updated dependencies [fe9fbdd]
- Updated dependencies [f3aefb9]
- Updated dependencies [0d33a89]
  - @perch/cli@0.2.0

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
