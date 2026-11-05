---
"@delacour/warden": minor
---

- iOS e2e and `warden ui`: when the simulator cannot name its frontmost app (seen on GitHub-hosted `macos-26` runners: every snapshot failed with `The simulator's accessibility service did not answer a frontmost request` or `named no frontmost application` while the app drew fine), snapshots are read by pid instead: the app warden launched, else SpringBoard. Before, the host fallback asked the same lookup and failed too.
- New `WARDEN_SIMD_FRONTMOST_COOLDOWN_S` (default 20, `0` always asks first) sets how long snapshots skip the frontmost lookup after it failed, and `WARDEN_SIMD_FRONTMOST_METHOD` (`window-server` default, `running-board`, `center-point`) sets how the in-sim bridge finds the frontmost app.
- These accessibility failures are now retryable `E_TIMEOUT` / `E_AX_UNAVAILABLE` instead of `E_INTERNAL`, so a locator keeps polling.
- `trace.jsonl`: every `driver.snapshot` span names its reader (`backend`). A pid read adds `targetPid` / `targetSource`. A failed snapshot records both readers' errors (`bridgeError`, `axError`, `axReason`) and the helper's state once per failure run: `bridge`, `bridgeLastError`, `hostXcode`, `helperXcode`, `coreSimulator`.
