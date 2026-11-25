---
"@delacour/warden": minor
---

- New `warden billing`: the warden cloud organization's prepaid balance, minutes left at $0.20/min, the free-trial state and the newest ledger entries (`--limit <n>`, `--json`). `warden billing --top-up [amount]` ($10–$500) opens Stripe Checkout; `--no-browser` prints the link.
- `warden whoami` shows the balance, minutes left and trial state (`billing` in `--json`).
- `warden login` registers this machine for the free trial with a hashed machine id (`HMAC-SHA256` of the OS machine id; the raw id never leaves the machine). `claim --remote` sends the same hash. `CI` runs send none.
- `claim --remote` out of credits fails with `remote claim failed: out of credits; top up at <url>` and the `--json` code `credits_exhausted` (with `billingUrl`); a trial waiting for a machine check fails with `machine_required_for_trial`; a member topping up gets `billing_role`.
- `warden heartbeat` warns when a hosted device's organization is low on credits or warden cloud stopped the device. `warden ls` shows `stop_reason: <reason>` for such devices (`stopReason` in `--json`) and `warden release --json` adds `remoteStopReasons`.
- `warden view` passes the top-up page to the viewer: it shows a low-balance banner, and "You've run out of credits" with a Top up button when the device is stopped for credits.
