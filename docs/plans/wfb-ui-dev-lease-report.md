# WFB-UI-DEV-LEASE — report

Branch `feature/wfb-ui-dev-lease`, commit `ac4f1250` (`✨ feat(ui): share the session's own warden dev device instead of device_busy`).

## Problem

`warden dev ios` holds its device lease by pid. `warden ui` from the same session hit the `exclusive` check → exit 2 `device_busy`, so agents needed `--force` (which also meant "disturb a running e2e").

## New attach semantics

- `Lease.shared?: boolean` (core, migration `ALTER TABLE leases ADD COLUMN shared INTEGER`), `Store.markShared(ids)`.
- `warden dev` marks the device leases it claims shared in `onLeased`, i.e. before the minutes-long install, so `ui` attaches during the build too.
- `ensureCallerLease` → `ownLease`: own lease held by another live process **and** `shared` → `action: "attached"`, exclusive or not. No heartbeat (the `warden dev` holder keeps it alive). Non-shared + `exclusive` → still `device_busy`.
- `warden ui` with no device named and several held leases picks the single live shared (`warden dev`) one instead of `ambiguous_device`.
- `ui open` text adds `sharing <leaseId> with warden dev (pid N)`.
- `--force` no longer needed for own `warden dev`; help/docs/skill updated.

## JSON shape

Success envelope gains an optional field, present only when the call attached:

```json
{ "ok": true, "...": "...", "attachedTo": "<leaseId>", "result": {}, "warnings": [] }
```

Absent on normal own/leased/reclaimed calls → backwards compatible.

## `ui close --release` on the shared lease

Keeps it. Stops the helper only (like plain `close`), JSON `released: false` and warning
`not released: <id> belongs to warden dev (pid N); stop warden dev (Ctrl-C) to release it`.
Ctrl-C on `warden dev` releases as before.

## Edge cases

| Case | Result |
|---|---|
| Another session's `warden dev` device | unchanged: `device_foreign` (shared only widens the *owner's* access) |
| Own running `warden e2e` / `batch` / `run` | unchanged: `device_busy` (not shared); `--force` still overrides |
| Shared lease whose `warden dev` pid is dead | ordinary own lease again: heartbeat, no `attachedTo`, `close --release` releases it |
| Several held leases, exactly one live `warden dev` | that one is picked |
| Several `warden dev` leases (e.g. `--count 2`, or two dev runs) | `ambiguous_device` listing them; name one with `--udid` |
| `warden ui` explicitly naming a non-dev held device | normal own-lease path |

## Verification

- `bun test` apps/cli (ui, dev, device-lease, help snapshots): 107 pass; packages/core store: 30 pass.
- `bun run typecheck && bun run check`: green.
- Real device run (2026-10-23): **blocked**. `warden dev ios` from this branch failed with
  `table leases has no column named shared`.

### Blocker: migration index collision

`MIGRATIONS` is index-keyed (`user_version` = count). Unmerged `candlefish` (WDN-CAP) also appends migration #8
(`CREATE TABLE boot_queue`). The global `warden` shim runs candlefish, so the shared `~/.warden/warden.db` is at
`user_version 8` with `boot_queue` and no `leases.shared`; this branch sees 8 ≥ 8 and skips its `ALTER`. Opposite order
would silently skip `boot_queue`. Not patched by hand: an ad-hoc `ALTER` breaks this branch once rebased after
candlefish (duplicate column), and an isolated `WARDEN_HOME` would hide leases from other agents.

Fix options:
- a. Merge order: whichever lands second rebases and appends its migration after the other (no code change).
- b. Make additive-column migrations idempotent (check `PRAGMA table_info` before `ADD COLUMN`) so parallel branches
  sharing one DB converge. Recommended: worktrees all share `~/.warden`, so this will recur.

## Open questions

0. Collision fix: a (merge order) or b (idempotent migrations)?
1. Should `ui` calls on an attached lease also heartbeat it (belt-and-braces if `warden dev`'s heartbeat loop stalls)? Current: no, holder owns liveness.
2. Should `close --release` on an attached lease exit non-zero instead of a warning? Current: exit 0 + warning.
3. Extend `shared` to `warden run` (long-lived human scripts) behind a flag? Current: dev only.
4. `pickHeld` with several live dev devices could prefer the most recent one instead of `ambiguous_device`. Current: ambiguous.
