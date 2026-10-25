#!/bin/bash
# One framework's bench on an EAS macOS worker. Called by apps/example/.eas/workflows/bench-baseline.yml, one job
# (one worker, one simulator) per framework so nothing one framework leaves behind reaches the next.
#
# Env (set by the workflow):
#   BENCH_FRAMEWORK   warden | argent | agent-device | tester-army
#   BENCH_APP         path of the downloaded .app
#   BENCH_RUNS        reps (rep 1 is cold)
#   BENCH_MAX_MINUTES hard stop for the whole job, measured from $HOME/job-start (written by the job's first step)
#   WARDEN_SESSION_ID so the bench's own warden calls own the lease; WARDEN_GOLDEN=0 (no goldens in a non-GUI session)
set -u
export PATH="$HOME/.bun/bin:$PATH"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
FW="${BENCH_FRAMEWORK:?}"
APP="${BENCH_APP:?}"
[ -e "$APP" ] || { echo "bench app not found: $APP (BENCH_APP must be the downloaded .app)"; exit 2; }
RUNS="${BENCH_RUNS:-5}"
MAX_MINUTES="${BENCH_MAX_MINUTES:-55}"
OUT="$ROOT/.bench/eas-ios-$FW"
mkdir -p "$OUT"
JOB_START=$(cat "$HOME/job-start" 2>/dev/null || date +%s)

log() { echo "== $* ($(date +%T), job ${SECONDS}s, load $(sysctl -n vm.loadavg))"; }
# progress <pid> <what> [logfile]: heartbeat every 20 s while pid runs, with the log's last line when given.
progress() {
  local pid=$1 what=$2 file=${3:-}
  while kill -0 "$pid" 2>/dev/null; do
    local last=""
    [ -n "$file" ] && [ -f "$file" ] && last=" | $(tail -n 1 "$file" | cut -c1-160)"
    echo "... $what $(date +%T) load=$(sysctl -n vm.loadavg | awk '{print $2}') booted=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted)$last"
    sleep 20
  done
}
remaining() { echo $(( MAX_MINUTES * 60 - ($(date +%s) - JOB_START) )); }

log "framework $FW, runs $RUNS, max ${MAX_MINUTES} min, $(remaining)s left"

# ---- deps -------------------------------------------------------------------------------------------------------
log "bun install"
bun install --frozen-lockfile > "$HOME/bun-install.log" 2>&1 &
progress $! "bun install" "$HOME/bun-install.log"; wait $! || { tail -n 40 "$HOME/bun-install.log"; exit 1; }

# warden-simd: the warden framework's helper; the harness also calls `warden ui close` while isolating every framework.
log "warden-simd deps + build"
( bun run --cwd packages/e2e native:deps && bun run --cwd packages/e2e native:build ) > "$HOME/simd-build.log" 2>&1 &
progress $! "warden-simd build" "$HOME/simd-build.log"; wait $! || { tail -n 60 "$HOME/simd-build.log"; exit 1; }

case "$FW" in
  argent)
    log "bun add -g @swmansion/argent"
    bun add -g @swmansion/argent > "$HOME/fw-install.log" 2>&1 &
    progress $! "argent install" "$HOME/fw-install.log"; wait $! || { tail -n 40 "$HOME/fw-install.log"; exit 1; }
    argent --version ;;
  agent-device)
    log "bun add -g agent-device"
    bun add -g agent-device > "$HOME/fw-install.log" 2>&1 &
    progress $! "agent-device install" "$HOME/fw-install.log"; wait $! || { tail -n 40 "$HOME/fw-install.log"; exit 1; }
    agent-device --version ;;
  tester-army) node -v ;;   # e2e + @e2e-dev/mobile come with bun install; the image's Node is inside e2e's range
  warden) ;;
  *) echo "unknown framework $FW"; exit 2 ;;
esac
log "bench doctor"
bun packages/e2e-bench/src/cli.ts doctor --platform ios || true

# ---- device -----------------------------------------------------------------------------------------------------
log "claim ios"
bun apps/cli/src/cli.ts claim ios --ttl 2h --label "bench-$FW" --headless --json > "$HOME/claim.json" &
progress $! "claim"; wait $! || { cat "$HOME/claim.json"; exit 1; }
cat "$HOME/claim.json"
LEASE=$(bun -e 'const j = JSON.parse(await Bun.file(process.env.HOME + "/claim.json").text()); console.log(j.leases[0].leaseId)')
UDID=$(bun -e 'const j = JSON.parse(await Bun.file(process.env.HOME + "/claim.json").text()); console.log(j.leases[0].udid)')
echo "$LEASE" > "$HOME/bench-lease-id"

# What the simulator shows and runs when we leave: a stuck dialog or a foreign foreground app is visible here.
evidence() {
  log "evidence"
  xcrun simctl io "$UDID" screenshot "$OUT/sim-final.png" 2>/dev/null || true
  xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -i "UIKitApplication" | sed 's/^/running app: /' || true
}
release() {
  evidence
  log "release $LEASE"
  bun apps/cli/src/cli.ts release "$LEASE" --shutdown || true
}
trap release EXIT
log "lease=$LEASE udid=$UDID"

log "install app"
xcrun simctl install "$UDID" "$APP" || { echo "simctl install failed"; exit 1; }

log "wait for load < ncpu"
NCPU=$(sysctl -n hw.ncpu)
FORCE=""
for _ in $(seq 1 40); do
  L1=$(sysctl -n vm.loadavg | awk '{print $2}')
  echo "load1=$L1 threshold=$NCPU $(date +%T)"
  awk -v l="$L1" -v n="$NCPU" 'BEGIN{exit !(l < n)}' && break
  sleep 15
done
awk -v l="$L1" -v n="$NCPU" 'BEGIN{exit !(l < n)}' || { FORCE="--force"; echo "load still above ncpu, running with --force"; }

log "idle control 60 s"
bun packages/e2e-bench/scripts/idle-sim.ts --udid "$UDID" --seconds 60 --launch nz.co.delacour.warden.example --out "$OUT/idle-control.ndjson" &
progress $! "idle control"; wait $! || echo "idle control failed (continuing)"

# ---- bench under the watchdog ----------------------------------------------------------------------------------
LEFT=$(remaining)
log "bench run, watchdog in ${LEFT}s"
if [ "$LEFT" -le 60 ]; then echo "no time left for the bench run"; exit 3; fi
bun packages/e2e-bench/src/cli.ts run --platform ios --frameworks "$FW" --runs "$RUNS" --udid "$UDID" --app "$APP" --out "$OUT" $FORCE > "$HOME/bench-run.log" 2>&1 &
BPID=$!
# The watchdog's sleep must not inherit the step's stdout: an orphaned sleep holding that pipe keeps the EAS step
# open until it ends. The subshell kills its sleep on TERM, and it is torn down children-first below.
(
  trap 'kill "$SLEEP_PID" 2>/dev/null; exit 0' TERM
  sleep "$LEFT" </dev/null >/dev/null 2>&1 & SLEEP_PID=$!
  wait "$SLEEP_PID" || exit 0
  echo "!! watchdog: ${MAX_MINUTES} min reached, stopping the bench (results so far are kept)"
  kill -TERM "$BPID" 2>/dev/null
  sleep 60 </dev/null >/dev/null 2>&1
  kill -KILL "$BPID" 2>/dev/null
) &
WDPID=$!
progress $BPID "bench $FW" "$HOME/bench-run.log"
wait $BPID; CODE=$?
pkill -TERM -P "$WDPID" 2>/dev/null; kill -TERM "$WDPID" 2>/dev/null; wait "$WDPID" 2>/dev/null || true
cp "$HOME/bench-run.log" "$OUT/" 2>/dev/null || true
log "bench exited $CODE"
tail -n 30 "$HOME/bench-run.log"
exit $CODE
