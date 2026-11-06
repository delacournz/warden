#!/usr/bin/env bash
# Prints each failed spec's screen-at-failure.txt into the job log, one collapsible group per file.
set -uo pipefail
echo "::group::busiest processes"
ps -Ao pid,pcpu,etime,command -r | head -12 | cut -c1-200
echo "::endgroup::"
batches="$HOME/.warden/batches"
if [ ! -d "$batches" ]; then echo "no batch directory at $batches"; exit 0; fi
found=0
while IFS= read -r file; do
  found=1
  echo "::group::${file#"$batches"/}"
  head -c 20000 "$file"
  echo
  echo "::endgroup::"
done < <(find "$batches" -name screen-at-failure.txt -type f | sort)
while IFS= read -r file; do
  echo "::group::tail ${file#"$batches"/}"
  tail -n 40 "$file" | cut -c1-300
  echo "::endgroup::"
done < <(find "$batches" -path '*/logs/*.log' -type f | sort | head -n 8)
if [ "$found" -eq 0 ]; then echo "no screen-at-failure.txt under $batches"; fi
exit 0
