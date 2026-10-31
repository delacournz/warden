# warden cloud (hosted devices, credits)

Hosted iOS / Android devices you lease like a local sim. Local sims and emulators stay free; hosted ones draw down the organization's prepaid credit.

## Account

| Need | Command |
|---|---|
| log in (a person, once per machine) | `warden login` (`--no-browser` prints the code; `--api-url <url>` for staging; `--json` → `{ apiUrl, user, organization, machine }`) |
| who am I, balance | `warden whoami [--json]` → account, org, remote status, `billing: { balanceUsd, ratePerMinuteUsd, estMinutesLeft, lowBalance, trial: { state, amountUsd }, billingUrl }` (`null` when billing can't be read) |
| organizations | `warden org list` · `warden org use <org>` |
| log out | `warden logout` |
| CI | `WARDEN_TOKEN` (+ `WARDEN_API_URL`); no login, no machine id |

`warden login` also registers this machine: the CLI hashes the OS machine id (`HMAC-SHA256("warden-machine-v1", id)`; macOS IOPlatformUUID, Windows MachineGuid, Linux `/etc/machine-id`) and sends only the hash. `machine` in the `--json` output: `registered` · `none` (no id, e.g. `CI` set) · `failed` (warning; paid use still works).

## Credits

- $0.20 per device-minute, billed per second from start to stop (boot counts). Prepaid only; credits never expire.
- Free trial: $2 per person, held until the first `claim --remote` from a machine you ran `warden login` on. A machine that already had a trial gets none (paid credit still works).
- At ~2 min left: heartbeats warn, the viewer shows a low-balance banner. At $0 warden cloud stops the device; the viewer shows "You've run out of credits" with **Top up**.

| Need | Command |
|---|---|
| balance, minutes left, trial, ledger | `warden billing [--limit <n>] [--json]` (default 10 entries, 1..100) → `{ billing, ledger: [{ id, kind, amountUsd, createdAt }] }`; kinds `grant` `grant_revoked` `topup` `usage` `refund` `dispute` `adjust` (unknown → `other`) |
| buy credit | `warden billing --top-up <amount>` ($10–$500, whole cents) opens Stripe Checkout; no amount = pick $10 / $20 / $50 at a terminal (agents must pass one). `--no-browser` prints the link. `--json` → `{ amountUsd, checkoutUrl, opened }`. Owners and admins only |

## Hosted devices

- `warden claim ios --remote --json` → `{ leases: [{ leaseId, remote: true, remoteId, platform, name }], remoteIds }`; one device per claim (`--profile` = model, `--runtime` = OS). Sends the machine hash as `X-Warden-Machine` when there is one.
- `release` / `heartbeat` stop / extend it like any lease. `heartbeat` warns `low balance ($0.30 left)` and `stopped: out of credits`.
- A device warden cloud stopped: `warden ls` shows `stop_reason: <reason>` in STATE (`--json`: `stopReason` on the lease); `warden release --json` → `remoteStopReasons: { <remoteId>: <reason> }`. Reasons: `user` `idle` `credits_exhausted` `error`.
- A person watches or drives it: `warden view [leaseId|remoteId] [--watch] [--detach] [--json]` or `claim --remote --view` (macOS, Windows). `WARDEN_VIEWER_PATH` = a local build, `WARDEN_VIEWER_URL` = release mirror. Agents never need it.

## Errors (`--json` failure `error.code`)

| Code | When | Fix |
|---|---|---|
| `credits_exhausted` | claim with no balance (HTTP 402); `error.billingUrl` = top-up page | A person runs `warden billing --top-up <amount>` (or opens `billingUrl`), then claim again |
| `machine_required_for_trial` | balance 0, trial waiting for a machine check (e.g. from CI) | `warden login` on your own machine and claim from there, or top up |
| `billing_role` | `--top-up` by a member | Ask an owner or admin |
