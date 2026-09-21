#!/usr/bin/env bash
# The local gate (AGENTS.md §2): everything CI runs, in CI's order, before a push to main.
#
#   bun run gate                      # the whole thing, ~30–40 minutes on four cores
#   PERCH_GATE_LOG=/tmp/gate.log bun run gate   # also append every step's output to a log
#
# It takes longer than most tool timeouts, so an agent runs it detached and polls the log:
#   (setsid nohup bash scripts/gate.sh > /tmp/gate.log 2>&1 &) ; grep -n '^===\|exit=' /tmp/gate.log
#
# Playwright's Chromium: when PLAYWRIGHT_CHROMIUM_EXECUTABLE is unset and a Playwright browsers
# directory exists (the CI image and the agent sandbox keep one at /opt/pw-browsers), the newest
# chromium there is used; otherwise Playwright finds its own.
set -u
cd "$(dirname "$0")/.." || exit 1

browsers="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ] && [ -d "$browsers" ]; then
  candidate="$(ls -d "$browsers"/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1)"
  if [ -n "$candidate" ]; then export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$candidate"; fi
fi

failed=()
step() {
  local name="$1"; shift
  echo "=== $name ($(date -u +%H:%M:%S)) ==="
  "$@"
  local code=$?
  echo "--- exit=$code ---"
  if [ "$code" -ne 0 ]; then failed+=("$name"); fi
}

step "web build" bun run --filter @perch/web build
step "check" bun run check
step "ct" bun run ct
step "e2e" env E2E_SKIP_BUILD=1 bun run e2e
step "perf" bun run perf
step "sdk:generate" bun run sdk:generate
step "sdk drift" bash -c '[ -z "$(git status --short packages/api-client)" ] || { git status --short packages/api-client; exit 1; }'
step "drill" bun run drill
step "reliability" bun run reliability

echo "=== DONE ($(date -u +%H:%M:%S)) ==="
if [ "${#failed[@]}" -eq 0 ]; then
  echo "gate: green"
  exit 0
fi
echo "gate: red in ${failed[*]}"
exit 1
