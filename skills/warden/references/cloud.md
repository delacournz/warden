# warden cloud (hosted devices, credits)

Hosted iOS / Android devices you lease like a local sim. Local sims and emulators stay free; hosted ones draw down the organization's prepaid credit.

## Account

| Need | Command |
|---|---|
| log in (a person, once per machine) | `warden login` (`--no-browser` prints the code; `--api-url <url>` for staging; `--org <slug\|id>` = default org, no prompt; `--json` → `{ account, apiUrl, user, organization, profiles: [{ account, organization }], machine }`) |
| login's orgs | one org → used. Several → a terminal asks which is the default; no terminal / `--json` → the session's active org, else the first. That org is made active and saved on the account; every other org is saved as a profile: account named by its slug, same session (`--account <slug>` or `warden org link <slug> --account <slug>`). An existing account of another user / api is never overwritten (warning). Unknown `--org` → exit 1, nothing saved |
| who am I, balance | `warden whoami [--json]` → account, org, remote status, `billing: { balanceUsd, ratePerMinuteUsd, estMinutesLeft, lowBalance, trial: { state, amountUsd }, billingUrl }` (`null` when billing can't be read) |
| Revyl approval | `remote.state: awaiting_approval` = the org owner already has a Revyl account; `warden whoami` prints `approve in Revyl with code <code>  <uri>` (`--json`: `remote.approval: { userCode, uri, expiresAt }`, owner only). Devices can't start until a person approves it in Revyl |
| Revyl dashboard | warden-web's **Open in Revyl** (`remote.dashboard: true`). A person signs in to Revyl themselves; agents never need it |
| organizations | `warden org list` (`*` = the org this directory uses) · `warden org use <org> [--account <name>]` (that account's fallback org) |
| more accounts | `warden login --account <name>` (name: `[a-z0-9-]`, ≤32; first login = `default`, and becomes the default) · `warden account [list] [--json]` (`*` default, `>` this directory) · `warden account default <name>` · `warden account rm <name>` |
| bind a directory to an org | `warden org link [org] [--account <name>] [--path <dir>] [--remote] [--json]`: default target = git top-level of cwd (else cwd); `--path` for a parent (every Orca worktree under `~/orca/workspaces/<repo>` matches); `--remote` = any checkout of `origin`. Longest path wins; path beats remote. No `<org>` = picker at a terminal (agents must pass one) |
| list / remove links | `warden org links [--json]` (`*` = the link matching cwd) · `warden org unlink [--path <dir>\|--remote]` |
| log out | `warden logout` (the account this directory uses) · `--account <name>` · `--all` → `--json` `{ loggedOut, revoked, kept, accounts }`; `kept: true` = another account (an org profile from the same login) still uses the session, so it was not revoked |
| CI | `WARDEN_TOKEN` (+ `WARDEN_API_URL`, `WARDEN_ORG`); no login, no machine id |

### Which account and org a command uses

Account: lease (release / heartbeat / view of a remote lease use what it was claimed under) > `WARDEN_ACCOUNT=<name>` > `warden org link` match > default account.
Org (sent as `X-Warden-Organization`): lease > `WARDEN_ORG=<slug|id>` > link > the account's `org use` org > the session's active org.
`warden whoami` prints `account <name>  via <path|remote|WARDEN_ACCOUNT|default>`; `--json` adds `account`, `accountVia`, `orgVia` (`lease` `env` `link` `account` `session`), `link`. Links live in `$WARDEN_HOME/links.json`, accounts in `$WARDEN_HOME/auth.json` (an old single-login file reads as account `default`).

`warden login` also registers this machine: the CLI hashes the OS machine id (`HMAC-SHA256("warden-machine-v1", id)`; macOS IOPlatformUUID, Windows MachineGuid, Linux `/etc/machine-id`) and sends only the hash. `machine` in the `--json` output: `registered` · `none` (no id, e.g. `CI` set) · `failed` (warning; paid use still works).

## Credits

- $0.20 per device-minute, billed per second from start to stop (boot counts). Prepaid only; credits never expire.
- Devices started directly in Revyl's dashboard are billed too: a nightly job debits that usage at the same rate.
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
| — `<dir> is linked to account <a>; run warden login --account <a>` | a link (or `WARDEN_ACCOUNT`, or a lease) names an account not logged in here | A person runs `warden login --account <a>`, or `warden org unlink` |
| — `not a member of <org>` / HTTP 403 `NOT_A_MEMBER` | the linked / `WARDEN_ORG` org isn't one of the account's | `warden org list --account <a>`, then relink |
