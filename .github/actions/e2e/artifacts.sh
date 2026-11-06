#!/usr/bin/env bash
# Collects what a run left on the runner into groups the action uploads (one artifact each) and hands their paths to
# the caller as outputs, so `upload-artifacts: false` lets a workflow upload only what it wants. bash 3.2 safe.
#
#   report   e2e-report.json
#   batches  ~/.warden/batches (spec logs, results.jsonl, screen-at-failure.txt, metro.log)
#   logs     ~/.warden/logs (native build logs)
#   app      app.tar: the .app / .apk builds the run used (`warden builds ls`, last used since STARTED), paths kept
#            relative to $HOME (`.warden/builds/<project>/…/X.app`) so a base and its repack never clash
#   golden   golden.tar: the golden simulator archived in ~/warden-goldens (`tar -xf golden.tar -C ~/warden-goldens`,
#            then `warden golden import ~/warden-goldens`), exported first when it was built but not archived
#
# app and golden are tarballs because upload-artifact drops the executable bit and follows symlinks: a raw .app would
# not launch and a raw golden would not import. Both land in $RUNNER_TEMP/warden-artifacts.
#
# `all` follows the outcome: a green run collects every group, a failed one report, batches, logs and golden.
# logs are always collected, whatever ARTIFACTS says (even `none`): they are small and, when the build broke, the
# only evidence there is.
#
# env: ARTIFACTS (all | none | comma list), PASSED (true | other), REPORT (absolute path), PROFILE (may be empty),
#      STARTED (epoch seconds the suite started; empty collects every cached build)
# outputs: groups (comma list), paths (JSON {group: [path]}), one multiline output per group, golden-archived
set -uo pipefail

ALL_GROUPS="report batches logs app golden"
out="${GITHUB_OUTPUT:-/dev/stdout}"
goldens="$HOME/warden-goldens"
temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
tars="$temp/warden-artifacts"
work=$(mktemp -d "$temp/warden-artifacts-paths.XXXXXX")
trap 'rm -rf "$work"' EXIT

case "$ARTIFACTS" in
  none | "") selected="" ;;
  all) if [ "${PASSED:-}" = true ]; then selected="$ALL_GROUPS"; else selected="report batches logs golden"; fi ;;
  *) selected=$(echo "$ARTIFACTS" | tr ',' ' ') ;;
esac
selected="$selected logs"

wants() {
  local group
  for group in $selected; do [ "$group" = "$1" ] && return 0; done
  return 1
}

# One file per group, one existing path per line.
add() { if [ -e "$2" ]; then echo "$2" >> "$work/$1"; fi; }

if wants report; then add report "$REPORT"; fi
if wants batches; then add batches "$HOME/.warden/batches"; fi
if wants logs; then add logs "$HOME/.warden/logs"; fi
# tar_into <group> <tarball> <dir> <entry…>: entries relative to dir; the tarball becomes the group's one path.
tar_into() {
  local group="$1" tarball="$2" dir="$3"
  shift 3
  mkdir -p "$tars"
  rm -f "$tarball"
  if tar -cf "$tarball" -C "$dir" "$@"; then
    add "$group" "$tarball"
  else
    echo "::warning title=$group not collected::tar of $* failed"
    rm -f "$tarball"
  fi
}

if wants app; then
  # Under $HOME (warden's builds) relative to it; anything else (an imported app-path) by its absolute path.
  home_apps=()
  root_apps=()
  while IFS= read -r app || [ -n "$app" ]; do
    [ -e "$app" ] || continue
    case "$app" in "$HOME"/*) home_apps+=("${app#"$HOME"/}") ;; *) root_apps+=("${app#/}") ;; esac
  done < <(
    warden builds ls --json 2> /dev/null | node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const since = Number(process.argv[1] || 0) * 1000;
      const used = (j.builds ?? []).filter((b) => b.size > 0 && b.lastUsedAt >= since);
      process.stdout.write([...new Set(used.map((b) => b.path))].join("\n"));
    ' "${STARTED:-}" 2> /dev/null
  )
  if [ ${#root_apps[@]} -gt 0 ]; then
    tar_into app "$tars/app.tar" / "${root_apps[@]}"
    if [ ${#home_apps[@]} -gt 0 ]; then tar -rf "$tars/app.tar" -C "$HOME" "${home_apps[@]}" || true; fi
  elif [ ${#home_apps[@]} -gt 0 ]; then
    tar_into app "$tars/app.tar" "$HOME" "${home_apps[@]}"
  fi
fi

archived=false
if wants golden; then
  profile_args=()
  if [ -n "${PROFILE:-}" ]; then profile_args=(--profile "$PROFILE"); fi
  name=$(warden golden key --json ${profile_args[@]+"${profile_args[@]}"} 2> /dev/null |
    node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).name ?? "")' 2> /dev/null)
  built=false
  if [ -n "$name" ] && warden golden ls --json 2> /dev/null |
    node -e 'process.exit(JSON.parse(require("fs").readFileSync(0, "utf8")).some((g) => g.name === process.argv[1]) ? 0 : 1)' "$name" 2> /dev/null; then
    built=true
  fi
  if [ -z "$name" ]; then
    echo "::warning title=golden not collected::warden golden key failed"
  elif [ -f "$goldens/$name/golden.json" ]; then
    archived=true
  elif [ "$built" = true ]; then
    # Built on this runner but not archived (a cache miss, or `cache: none`). Never build one just to upload it.
    if warden golden export "$goldens" --allow-unsettled ${profile_args[@]+"${profile_args[@]}"}; then
      archived=true
    else
      echo "::warning title=golden not collected::warden golden export failed"
    fi
  else
    echo "golden $name was never built on this runner: nothing to collect"
  fi
  if [ "$archived" = true ]; then tar_into golden "$tars/golden.tar" "$goldens" "$name"; fi
fi

groups=""
for group in $ALL_GROUPS; do
  if [ -s "$work/$group" ]; then groups="${groups:+$groups,}$group"; fi
done

json=$(node -e '
  const fs = require("fs");
  const [dir, all] = process.argv.slice(1);
  const o = {};
  for (const g of all.split(" ")) {
    const f = dir + "/" + g;
    o[g] = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  }
  process.stdout.write(JSON.stringify(o));
' "$work" "$ALL_GROUPS")

{
  echo "groups=$groups"
  echo "paths=$json"
  echo "golden-archived=$archived"
  for group in $ALL_GROUPS; do
    echo "$group<<WARDEN_ARTIFACT_PATHS"
    if [ -s "$work/$group" ]; then cat "$work/$group"; fi
    echo "WARDEN_ARTIFACT_PATHS"
  done
} >> "$out"

echo "artifact groups: ${groups:-none}"
echo "$json"
exit 0
