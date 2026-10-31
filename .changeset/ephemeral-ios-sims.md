---
"@delacour/warden": minor
---

- iOS sims are ephemeral: once a warden sim shuts down (`warden release --shutdown`, SessionEnd, `warden gc`, a passed `warden e2e`) it is deleted, and the next claim clones a fresh one from the golden, so old `warden-<profile>-N` sims no longer pile up. Quarantined (`--bad`), foreign and physical devices are kept.
- `warden gc` (and auto-gc, once per machine for sims an older warden left) deletes every shut-down, unleased warden sim; `release --json` and `gc --json` list them under `deleted`.
- `warden release --bad --shutdown` quarantines before the shutdown, so the bad sim is kept for `warden sim unquarantine`.
- `WARDEN_EPHEMERAL=0` (or `WARDEN_GOLDEN=0`) keeps the persistent pool.
