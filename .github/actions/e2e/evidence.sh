#!/usr/bin/env bash
# Prints each failed spec's screen-at-failure.txt into the job log, one collapsible group per file.
set -uo pipefail
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
if [ "$found" -eq 0 ]; then echo "no screen-at-failure.txt under $batches"; fi
exit 0
