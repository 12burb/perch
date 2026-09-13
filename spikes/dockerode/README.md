# Spike 0.4.7 — dockerode from Bun

**Pass criterion:** the supervisor creates, limits, execs into, and removes a runner container.

**Outcome (ADR-0035): deferred to CI.** The build environment for Phase 0 has no Docker daemon, so the
spike cannot be verified here. The test skips with a reason when neither `/var/run/docker.sock` nor
`DOCKER_HOST` is present and runs in `.github/workflows/spikes.yml` on the ubuntu runner, where Docker is
available: pull `alpine:3.20`, create with `NanoCpus`, `Memory`, and `PidsLimit`, start, exec, stop, remove,
and confirm nothing is left behind.

```sh
bun test spikes/dockerode        # skips without a daemon
```

Fallback if CI fails: the supervisor runs on Node LTS in its own image (spec §9.3). Task 1.2 reads the CI
result before building the supervisor.
