---
"@delacour/warden": minor
---

- Device conditions set on a lease (network, location, clock, …) are always undone when the lease is released or garbage-collected.
- Android emulators can be set offline (airplane mode, checked against the device's connectivity state) or shaped to the `edge`, `3g`, `4g`, `lte`, `wifi`, `slow` and `lossy` network presets.
- A per-lease network shaping proxy throttles bandwidth, adds latency, jitter and packet loss, and injects per-host faults (HTTP status, reset, delay, blackhole); it is stopped and its port freed when the lease is released.
- Simulated location: set a point, follow a route of waypoints (speed, interval), replay a GPX file, or run a built-in scenario (`city-run`, `city-bike`, `freeway`) on iOS simulators and Android emulators.
- Flaky networks: flap between online and offline on a schedule (with seeded jitter), or run a timeline of network and location changes; every change is recorded next to the test results.
- iOS simulator apps get network conditions per app: launched with a small injected library that sends their traffic through the lease's shaping proxy, so presets and offline switch live without touching the Mac's network or other simulators. A running app without it fails with `E_NETWORK_RELAUNCH` unless the relaunch is opted into.
- Spec API: `device.network.set/during/flap/fault/status/reset`, `device.location.set/route/scenario/clear`, `device.clock.set/advance/during/reset` and `device.timeline([...])`; `during` restores the previous condition even when the callback throws.
- `warden.config.ts` takes a `conditions` key (top level or per `e2e` suite) for `network`, `location` and `clock`; each spec starts from that baseline.
- iOS: apps using `NSURLSession.sharedSession` are shaped too, and changing a host fault cuts connections already open to that host.
- Mock clock: shift (`offset`), set (`fixed`) or freeze (iOS) the wall clock an app sees; monotonic clocks are untouched. Android emulators set the device time; frozen time is iOS only.
- Specs know their lease (`WARDEN_LEASE_ID`): network and clock conditions work under `warden e2e` on iOS, and every condition a spec sets is recorded, so a crashed spec process is still undone when the lease is released.
- `warden ui network` is now a group: `network log` shows the request log (the old `warden ui network [n]` still works and points to it), and `network set <preset>`, `network flap`, `network fault`, `network status`, `network reset` set conditions on the device.
- New `warden ui location set|route|gpx|scenario|clear|status` and `warden ui clock set|advance|status|reset`; `warden ui status` lists the conditions active on the lease.
- Releasing a lease also puts a still-running iOS app launched with network or clock conditions back online and on the real clock.
