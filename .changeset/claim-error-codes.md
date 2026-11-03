---
"@delacour/warden": minor
---

- A failed device claim now says why with a code and its own exit code: `NO_DEVICE` (5, every matching device leased at `--max`), `QUEUE_TIMEOUT` (6, `--wait` ran out behind other claims), `NO_CAPACITY` (7, no room to boot, with `capacityReason` `ram-budget`, `cpu-budget`, `memory-pressure` or `host-load`), `RUNTIME_MISSING` (9), `HEALTH_FAILED` (10) and `LEASE_LOST` (11); `REQUESTER_LIMIT` (8) is reserved. Exit 1 stays the generic failure.
- `warden claim`, `run`, `batch` and `e2e` with `--json` print `{ok:false, command, error:{code, message, hint}}` for these, and `warden ui --claim` returns the same codes in its envelope.
- The human error line drops the code and adds a one-line hint naming the fix.
