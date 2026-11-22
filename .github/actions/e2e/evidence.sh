#!/usr/bin/env bash
# Prints each failed spec's screen-at-failure.txt into the job log, one collapsible group per file.
# A screen and a log are text the app wrote: each is printed between `::stop-commands::` and its
# one-off token, so the runner reads no line of it as a workflow command.
set -uo pipefail
echo "::group::busiest processes"
ps -Ao pid,pcpu,etime,command -r | head -12 | cut -c1-200
echo "::endgroup::"
batches="$HOME/.warden/batches"
if [ ! -d "$batches" ]; then echo "no batch directory at $batches"; exit 0; fi
found=0
while IFS= read -r file; do
  found=1
  token="warden-$(uuidgen)"
  echo "::group::${file#"$batches"/}"
  echo "::stop-commands::$token"
  head -c 20000 "$file"
  echo
  echo "::$token::"
  echo "::endgroup::"
done < <(find "$batches" -name screen-at-failure.txt -type f | sort)
while IFS= read -r file; do
  token="warden-$(uuidgen)"
  echo "::group::tail ${file#"$batches"/}"
  echo "::stop-commands::$token"
  tail -n 40 "$file" | cut -c1-300
  echo "::$token::"
  echo "::endgroup::"
done < <(find "$batches" -path '*/logs/*.log' -type f | sort | head -n 8)
if [ "$found" -eq 0 ]; then echo "no screen-at-failure.txt under $batches"; fi
exit 0
