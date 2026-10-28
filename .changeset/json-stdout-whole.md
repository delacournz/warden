---
"@delacour/warden": patch
---

- `--json` output larger than 64 KB is no longer cut off when the reader is slow to start (an agent, `jq` behind another step): warden waits for stdout to flush before it exits
- `warden dev --json` prints its `{ udid, port, metroUrl, leaseIds, source }` document on one line, so the first stdout line is the whole document as documented
- `warden run --json` prints its summary on one line and sends the child's stdout to stderr, so stdout holds only the JSON document
