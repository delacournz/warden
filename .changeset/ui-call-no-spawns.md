---
"@delacour/warden": patch
---

- Every `warden` command in a git checkout reads the repo, worktree and branch from the checkout's files instead of running `git`: `warden ui status` 37 → 27 ms
- iOS: opening the driver (each `warden ui` command, each spec) reads the simulator's accessibility and keyboard preferences in-process instead of running `plutil` four times: `warden ui snapshot -i` 125 → 112 ms, a fifth less CPU per call
