# Spike 0.4.1 — PTY on Bun

**Pass criterion:** a PTY opens a shell, resizes, and survives 1,000 writes on linux x64/arm64, macOS, Windows.

**Outcome (ADR-0029): fallback taken.** On Bun 1.3.11 / linux x64, `node-pty` 1.1.0 spawns and echoes, but
`resize()` throws `ioctl(2) failed, EBADF` and sustained writes fail with `EBADF`: Bun's `net.Socket({ fd })`
does not keep node-pty's master fd usable. `bun-pty` 0.4.10 (Bun-native, FFI) passes the whole scenario in
about half a second, so bun-pty is the PTY on Bun. node-pty stays as an opt-in probe
(`PERCH_SPIKE_NODE_PTY=1 bun test spikes/pty`) so the CI matrix can re-check it per platform.

```sh
bun test spikes/pty                          # bun-pty (asserted)
PERCH_SPIKE_NODE_PTY=1 bun test spikes/pty   # also probe node-pty
```

Platforms: `.github/workflows/spikes.yml` runs this on ubuntu-latest, ubuntu-24.04-arm, macos-latest, and
windows-latest.
