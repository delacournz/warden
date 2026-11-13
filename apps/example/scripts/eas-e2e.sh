#!/bin/bash
# warden e2e on an EAS macOS worker. Called by apps/example/.eas/workflows/e2e.yml with an EAS simulator build of
# this fingerprint: imports it as warden's simulator-base, then `warden e2e` repacks this checkout's JS into it,
# claims a simulator, installs and runs the suite. Evidence lands in $HOME/e2e-results for the artifact upload.
#
# Env (set by the workflow):
#   E2E_APP          downloaded .app (Release, iphonesimulator, no dev client)
#   E2E_SUITE        warden.config.ts e2e suite (default example)
#   E2E_ARGS         extra `warden e2e` arguments (word-split)
#   E2E_COUNT        simulators in parallel (default 1)
#   E2E_RETRY        reruns of a failed spec (default 1)
#   E2E_HELPER       release (fetch warden-simd for this version) | source (build it from this checkout)
#   E2E_MAX_MINUTES  hard stop, measured from $HOME/job-start (written by the job's first step)
#   NPM_TOKEN        EAS secret: bun install pulls @delacournz/* from GitHub Packages
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
APP="${E2E_APP:?E2E_APP must be the downloaded .app}"
[ -d "$APP" ] || { echo "app not found: $APP"; exit 2; }
SUITE="${E2E_SUITE:-example}"
COUNT="${E2E_COUNT:-1}"
RETRY="${E2E_RETRY:-1}"
HELPER="${E2E_HELPER:-release}"
MAX_MINUTES="${E2E_MAX_MINUTES:-45}"
OUT="$HOME/e2e-results"
WARDEN_DIR="${WARDEN_HOME:-$HOME/.warden}"
mkdir -p "$OUT"
JOB_START=$(cat "$HOME/job-start" 2>/dev/null || date +%s)

log() { echo "== $* ($(date +%T), job $(( $(date +%s) - JOB_START ))s, load $(sysctl -n vm.loadavg))"; }
remaining() { echo $(( MAX_MINUTES * 60 - ($(date +%s) - JOB_START) )); }

collect() {
  log "collect evidence"
  cp -R "$WARDEN_DIR/batches" "$OUT/batches" 2>/dev/null || true
  mkdir -p "$OUT/logs"
  cp "$WARDEN_DIR"/logs/*.log "$WARDEN_DIR"/simd/*.log "$OUT/logs/" 2>/dev/null || true
  cp "$HOME"/bun-install.log "$HOME"/simd-build.log "$OUT/logs/" 2>/dev/null || true
  # screen-at-failure.txt is the full AX tree of each failed test: print it so the job log alone explains a red run.
  find "$OUT/batches" -name screen-at-failure.txt 2>/dev/null | while read -r f; do
    echo "=== $f"; head -n 80 "$f" | cut -c1-240
  done
  ls -R "$OUT" | head -n 60
}
trap collect EXIT

# ---- deps -------------------------------------------------------------------------------------------------------
[ -n "${NPM_TOKEN:-}" ] || echo "!! NPM_TOKEN is not set: add it as a secret in the job's EAS environment (bun install needs @delacournz/* from GitHub Packages)"
log "bun install"
bun install --frozen-lockfile > "$HOME/bun-install.log" 2>&1 || { tail -n 40 "$HOME/bun-install.log"; exit 1; }

# This checkout's CLI, so the job tests the branch it runs on.
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec bun "%s/apps/cli/src/cli.ts" "$@"\n' "$ROOT" > "$HOME/.local/bin/warden"
chmod +x "$HOME/.local/bin/warden"
warden --version

case "$HELPER" in
  source)
    # packages/e2e/native/dist, which the driver prefers over $WARDEN_HOME/simd.
    log "warden-simd build from source"
    ( bun run --cwd packages/e2e native:deps && bun run --cwd packages/e2e native:build ) > "$HOME/simd-build.log" 2>&1 \
      || { tail -n 60 "$HOME/simd-build.log"; exit 1; } ;;
  release)
    log "warden-simd from the release"
    (cd apps/example && warden doctor --fetch-helper) || exit 1 ;;
  *) echo "E2E_HELPER must be release or source, got $HELPER"; exit 2 ;;
esac
(cd apps/example && warden doctor) || true

# ---- reuse the EAS build ------------------------------------------------------------------------------------------
# Filed under this checkout's native fingerprint; its embedded bundle is stripped, every repack writes its own.
log "import the EAS build as the simulator base"
cd "$ROOT/apps/example" || exit 1
if warden builds import "$APP" --kind simulator-base --json > "$OUT/import.json"; then
  cat "$OUT/import.json"
  grep -q '"applicationIdentifier": *false' "$OUT/import.json" \
    && echo "!! the EAS build has no application-identifier entitlement: Keychain calls fail with -34018 (errSecMissingEntitlement)"
else
  cat "$OUT/import.json" 2>/dev/null
  echo "!! builds import refused the EAS build: warden e2e builds the simulator base itself (native build, minutes)"
fi

# shellcheck disable=SC2206
EXTRA=(${E2E_ARGS:-})

# Repack this checkout's JS into the imported base (same kind and bundle env as the run, so the run reuses it), or
# build the base when the import was refused. Its own step, so the suite's timing is the specs alone.
log "warden e2e $SUITE --build-only (repack if needed)"
warden e2e "$SUITE" --build-only ${EXTRA[@]+"${EXTRA[@]}"} || exit 1

# ---- suite under the watchdog -------------------------------------------------------------------------------------
LEFT=$(remaining)
[ "$LEFT" -gt 60 ] || { echo "no time left for the suite (${LEFT}s)"; exit 3; }
log "warden e2e $SUITE --count $COUNT --retry $RETRY ${EXTRA[*]:-} (watchdog in ${LEFT}s)"
warden e2e "$SUITE" --count "$COUNT" --retry "$RETRY" --headless --report "$OUT/e2e-report.json" ${EXTRA[@]+"${EXTRA[@]}"} &
SUITE_PID=$!
# shellcheck disable=SC2217
# The watchdog's sleep must not inherit the step's stdout: an orphan holding that pipe keeps the EAS step open.
(
  trap 'kill "$SLEEP_PID" 2>/dev/null; exit 0' TERM
  sleep "$LEFT" </dev/null >/dev/null 2>&1 & SLEEP_PID=$!
  wait "$SLEEP_PID" || exit 0
  echo "!! watchdog: ${MAX_MINUTES} min reached, stopping warden e2e"
  kill -INT "$SUITE_PID" 2>/dev/null
  sleep 60 </dev/null >/dev/null 2>&1
  kill -KILL "$SUITE_PID" 2>/dev/null
) &
WATCHDOG_PID=$!
wait "$SUITE_PID"; CODE=$?
pkill -TERM -P "$WATCHDOG_PID" 2>/dev/null; kill -TERM "$WATCHDOG_PID" 2>/dev/null; wait "$WATCHDOG_PID" 2>/dev/null || true
log "warden e2e exited $CODE"
exit "$CODE"
