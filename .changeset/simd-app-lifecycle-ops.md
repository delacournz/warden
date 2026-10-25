---
"@delacour/warden": patch
---

- iOS `app.launch`, `app.terminate` and `app.openUrl` (every spec `app.open`, `device.openLink` and `warden ui open`) run inside the resident `warden-simd` helper instead of spawning `xcrun simctl` for each call: the helper already holds CoreSimulator, which every `simctl` process loaded again (about 0.13 CPU-s on the host per launch, roughly 40 % of warden's host CPU per bench rep). Launch arguments and environment reach the app as before, `relaunch: false` keeps a running instance, terminating an app that is not running is still a success, and the `driver.app.launch` span now carries `via` (`simd` or `simctl`) and the app's `pid`.
- A helper built before these ops answers once and the driver falls back to `simctl` for the rest of the session (`[ios] this warden-simd predates the \`launch\` op …` in the log; restart it with `warden ui close --udid <udid>` or rebuild with `bun run --cwd packages/e2e native:build`). Install, uninstall, `isRunning` and `clearData` stay on `simctl`.
