---
"@delacour/warden": minor
---

- Every device lease now leaves a trail in an append-only event log: `requested`, `queued`, `granted` (with the wait), `released`, `expired`, `heartbeat_lost`, `evicted`, `quarantined`, `unquarantined` and `shutdown`. Each row is written in the same transaction as the change it records.
- New `warden events [--since 1h] [--lease <id>] [--owner <owner>] [--follow] [--json]` prints the history. `--follow` polls every second and, with `--json`, prints one event per line.
- New `warden stats [--since 7d] [--json|--csv]` reports claims, median and p95 wait, lease durations and peak concurrency per platform and profile.
- `warden gc` prunes events older than 7 days; `WARDEN_EVENTS_DAYS=<n>` changes the retention.
