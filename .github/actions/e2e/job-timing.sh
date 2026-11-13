#!/usr/bin/env bash
# One log line splitting the job's time up to the suite's end: the steps before this action (checkout, builds,
# toolchains), the action's own prep (install, doctor, caches, golden), and `warden e2e` itself (claim, boot,
# install and the specs, which warden's own `took … — setup · tests · teardown` line splits further).
#
# Env (epoch seconds): ACTION_STARTED, SUITE_STARTED, SUITE_ENDED, and JOB_STARTED when the caller knows it.
# BUILD_STARTED (the `warden e2e --build-only` step) splits an `app build` span off the action's prep, up to the suite.
# Without JOB_STARTED it is read from the jobs API (JOB_TIMING_TOKEN, needs `actions: read`): the job on this
# runner that is in progress. Any failure falls back to the action's part alone. Never fails the job.
# Bash 3.2 (macOS system bash): no associative arrays, no ${var^^}.
set -u

[ -n "${SUITE_STARTED:-}" ] && [ -n "${SUITE_ENDED:-}" ] && [ -n "${ACTION_STARTED:-}" ] || exit 0

# 3720 → 1h2m, 160 → 2m40s, 120 → 2m, 26 → 26s (warden's formatDuration)
fmt() {
  local s=$1 m h
  [ "$s" -lt 0 ] && s=0
  if [ "$s" -lt 60 ]; then echo "${s}s"; return; fi
  m=$((s / 60))
  if [ "$m" -lt 60 ]; then
    if [ $((s % 60)) -eq 0 ]; then echo "${m}m"; else echo "${m}m$((s % 60))s"; fi
    return
  fi
  h=$((m / 60))
  if [ $((m % 60)) -eq 0 ]; then echo "${h}h"; else echo "${h}h$((m % 60))m"; fi
}

span() { local d=$(($2 - $1)); [ "$d" -lt 0 ] && d=0; echo "$d"; }

job_started() {
  if [ -n "${JOB_STARTED:-}" ]; then echo "$JOB_STARTED"; return; fi
  [ -n "${JOB_TIMING_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ] || return 0
  command -v curl > /dev/null && command -v jq > /dev/null || return 0
  local url="${GITHUB_API_URL:-https://api.github.com}/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100"
  curl -fsS --max-time 10 -H "Authorization: Bearer $JOB_TIMING_TOKEN" -H "Accept: application/vnd.github+json" "$url" 2> /dev/null |
    jq -r --arg runner "${RUNNER_NAME:-}" \
      '[.jobs[] | select(.status == "in_progress" and .runner_name == $runner) | .started_at | fromdateiso8601] | first // empty' 2> /dev/null
}

job=$(job_started)
build=0
build_part=""
if [ -n "${BUILD_STARTED:-}" ]; then
  action=$(span "$ACTION_STARTED" "$BUILD_STARTED")
  build=$(span "$BUILD_STARTED" "$SUITE_STARTED")
  build_part=" · app build $(fmt "$build")"
else
  action=$(span "$ACTION_STARTED" "$SUITE_STARTED")
fi
suite=$(span "$SUITE_STARTED" "$SUITE_ENDED")

if [ -z "$job" ]; then
  echo "job timing: action prep $(fmt "$action")$build_part · warden e2e $(fmt "$suite") (job start unknown: the token needs actions: read)"
  exit 0
fi
workflow=$(span "$job" "$ACTION_STARTED")
prep=$((workflow + action))
echo "job timing: prep $(fmt "$prep") (workflow steps $(fmt "$workflow") · action $(fmt "$action"))$build_part · warden e2e $(fmt "$suite") · total $(fmt $((prep + build + suite)))"
