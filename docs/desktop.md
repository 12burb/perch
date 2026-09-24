# The desktop app

`perch-desktop` is Perch on one machine in its own window: laptop mode (api, web, and the in-process
runner on PGlite under `~/.perch`) started by the app itself and shown in the platform's webview
(WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux). No browser tab, no terminal, no Docker.
The design is ADR-0063; the code is `apps/desktop`.

## Install

| Platform | Get | Run |
|---|---|---|
| macOS (Apple silicon) | `Perch-macos-arm64.app.zip` from the release page | unzip, move `Perch.app` to Applications, open it. The bundle is not notarized yet: the first time, right-click → Open (or `xattr -d com.apple.quarantine Perch.app`) |
| Windows (x64) | `perch-desktop-windows-x64.exe` | double-click. WebView2 ships with Windows 11 and Edge; SmartScreen may ask to confirm an unsigned app |
| Linux (x64, arm64) | `perch-desktop-linux-<arch>` | `sudo apt install libwebkit2gtk-4.1-0 libxdo3` (Debian/Ubuntu; `webkit2gtk4.1 libxdo` on Fedora, `webkit2gtk-4.1 xdotool` on Arch), `chmod +x`, run |

Intel Macs: the desktop binary is not built for x64 macOS yet; `perch dev` (the CLI) works there in a
browser. Everything the app stores lives under `~/.perch`, the same directory `perch dev` uses; the
window's cookies, storage, and cache are in `~/.perch/desktop/webview`. Only one Perch runs on a data
directory at a time (`~/.perch/perch.lock`, ADR-0175): with `perch dev` running there, the app says which
process holds it and exits rather than opening the same database twice — stop `perch dev`, point it at
the app's port (`perch dev --port 47160`, which the app then attaches to), or give one of them
`--data-dir`.

## What it does

- Listens on `http://localhost:47160` (`--port` changes it). A fixed port keeps the origin stable, so the
  session cookie and passkeys survive restarts; `localhost` rather than `127.0.0.1` because passkeys need
  a domain as the relying party.
- If a Perch already answers on that port (a second launch, or `perch dev --port 47160`), the app opens a
  window on it instead of starting a second server.
- Closing the window stops the server. On macOS the app menu has Quit and the Edit shortcuts.
- `--url https://perch.example.com` opens a team instance in the same window, with its own persistent
  browsing data; no local server runs.
- `--check` loads the platform webview and exits 0 or 1, naming the engine version: what CI uses.
  `--smoke` goes further: a throwaway laptop mode on a random port, one window, closed after the first
  page load, exit 0; every step and page event is traced on stderr, so a stalled platform says where.
  On Windows the binary has no console window: started from a shell it still writes to that shell's
  pipes, and started by a click (nothing attached) it writes everything, the server's log included, to
  `%USERPROFILE%\.perch\desktop\perch-desktop.log` (rotated once past 5 MB).
- `--data-dir` and `--log-level` mirror `perch dev`.
- On Windows the window runs the platform's native event loop on the main thread and the server runs in
  a second process of the same binary (`perch-desktop --serve`, stopped when the window closes; ADR-0063
  explains why); on macOS and Linux the server runs in-process. `PERCH_DESKTOP_SERVER=child` picks the
  two-process layout on any platform, which is how the tests cover it everywhere.

## Build

```sh
bun run --filter @perch/web build
bun scripts/build-desktop.ts --out dist/desktop --version 0.1.0
```

Builds run on the target platform (the native addon is installed per platform); the release workflow
has one job per platform and attaches `perch-desktop-<os>-<arch>`, the macOS `.app` zip, and checksums
to the release. From source: `bun apps/desktop/src/index.ts`.

## Tests

`bun test apps/desktop`: the flow with fakes, `--check` on the real addon, and a real window on laptop
mode wherever a display exists (`xvfb-run -a bun test apps/desktop` on a headless Linux box). CI runs it
on Linux, macOS, and Windows with `PERCH_DESKTOP_NATIVE=1`, which turns the skips into failures.
