---
"@delacour/warden": minor
---

- `warden queue` and `warden queue --json` show a `reason` for every waiting claim: `behind-earlier`, `ram-budget`, `cpu-budget`, `memory-pressure`, `host-load`, `device-limit` (every matching device leased at `--max`) or `waiting-for-device` (no free ready physical device). The reason is stored on the queue row and rewritten every poll.
- Claims polling for a device now appear in `warden queue` without a position; they hold no boot slot and never delay other claims.
- The "queued" and "waiting for" progress lines end with the reason in brackets.
- `warden capacity` uses the same usage and budget check as claims, and `--json` gains `blocked` (the resource a boot would run out of now, or `null`).
