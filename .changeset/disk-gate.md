---
"@delacour/warden": minor
---

- `warden claim` (and `run`, `dev`, `batch`) refuses to boot or create a device when free space is under the critical threshold, failing with `DISK_LOW` and the free space it saw; reusing an already booted device is always allowed. Swap above its warn threshold queues the claim the way memory pressure does.
- A background `warden gc` starts at once when free space drops under the disk floor, without waiting for the usual 10-minute interval (at most once a minute).
- `WARDEN_GC_WORKTREES=merged` lets `warden gc` remove clean, merged git worktrees, as `warden worktrees --apply` does; off by default. `warden disk` lists worktrees with what is removable.
- `warden hook session-start` prints one line for the agent when the disk is low or swap is high (reuse booted devices, avoid parallel builds), and nothing otherwise; `warden install` adds it to Claude Code and Codex hooks and `warden doctor` checks it.
- `WARDEN_DISK=off` turns off the claim gate, the low-disk gc trigger and the session-start hint.
