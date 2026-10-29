# WDN-COND — Dynamic device conditions: network, location, + friends

Goal: specs (`*.e2e.ts`), `warden.config.ts` suites and `warden ui` can set, change mid-test, and schedule device conditions — network (offline / slow / throttled / lossy / flaky), location (point / moving route / GPX), plus permissions, locale/timezone, accessibility, battery, memory pressure, push. Every condition is lease-scoped and **always undone on release** (no leaked state to the next agent).

## Mechanisms (verified on this machine / documented tooling)

| Area | iOS sim | Android emu | Physical |
|---|---|---|---|
| Location point | `xcrun simctl location <udid> set lat,lon` | `adb -s <s> emu geo fix <lon> <lat> [alt]` (lon first!) | `E_UNSUPPORTED` |
| Location route | `simctl location <udid> start --speed=<m/s> --interval=<s> p1 p2 …` (stdin `-` for long lists) | warden ticker: interpolate waypoints, `emu geo fix` every interval | `E_UNSUPPORTED` |
| Location scenario | `simctl location run "City Run"\|"City Bicycle Ride"\|"Freeway Drive"` | map same names to bundled waypoint sets | — |
| Location clear | `simctl location <udid> clear` | stop ticker (last fix stays; document) | — |
| Network speed/latency | **none per-sim** (shares host stack) → per-lease proxy (COND-4/5) | `adb emu network speed <gsm\|edge\|umts\|hsdpa\|lte\|full\|up:down>`, `emu network delay <none\|gprs\|edge\|umts\|min:max>` | — |
| Offline | proxy blackhole + NetInfo shim (COND-5) | `cmd connectivity airplane-mode enable` (fallback `svc wifi disable; svc data disable`) | — |
| Loss / jitter / resets / per-host faults | per-lease proxy | per-lease proxy via `settings put global http_proxy 10.0.2.2:<port>` | — |
| Flaky (flapping) | warden scheduler toggles offline/online | same | — |
| Permissions | `simctl privacy <udid> grant\|revoke\|reset <service> <bundle>` | `pm grant\|revoke`, `appops set` | — |
| Push | `simctl push <udid> <bundle> payload.json` | `E_UNSUPPORTED` (no FCM inject; doc in-app test hook) | — |
| Timezone | launch env `SIMCTL_CHILD_TZ` | `cmd alarm set-timezone` / `setprop persist.sys.timezone` | — |
| Locale | launch args `-AppleLanguages (xx) -AppleLocale xx_YY` | `cmd locale set-app-locales <pkg> --locales xx-YY` (API 33+) | — |
| Text size / a11y | `simctl ui <udid> content_size <size>`, `increase_contrast` | `settings put system font_scale`, `settings put secure accessibility_display_inversion_enabled` etc | — |
| Battery | cosmetic only: `simctl status_bar override --batteryLevel` (exists) | `dumpsys battery set level/status`, `unplug`; `reset` | — |
| Memory pressure | `simctl spawn <udid> notifyutil -p com.apple.system.lowmemory` (verify in COND-9) | `am send-trim-memory <pkg> RUNNING_CRITICAL` | — |

Why not host-wide Network Link Conditioner / `pfctl`+`dnctl` for iOS: needs sudo, throttles every sim + the Mac + other agents' leases. Violates "foreign = read-only". Only allowed behind an explicit exclusive host lease (stretch, COND-11, off by default).

## Model

```ts
type NetworkCondition =
  | { kind: "online" }
  | { kind: "offline" }
  | { kind: "preset"; preset: NetworkPreset }               // "edge" | "3g" | "4g" | "lte" | "wifi" | "slow" | "lossy"
  | { kind: "custom"; latencyMs?: number; jitterMs?: number; downKbps?: number; upKbps?: number; lossPct?: number }
  | { kind: "flap"; upMs: number; downMs: number; jitterPct?: number; base?: NetworkCondition };

type HostFault = { match: string; action: { kind: "status"; code: number } | { kind: "reset" } | { kind: "delay"; ms: number } | { kind: "blackhole" } };

type LocationCondition =
  | { kind: "point"; lat: number; lon: number; altM?: number }
  | { kind: "route"; points: readonly LatLon[]; speedMps?: number; intervalS?: number; loop?: boolean }
  | { kind: "gpx"; path: string; speedMps?: number }           // parsed → route
  | { kind: "scenario"; name: "city-run" | "city-bike" | "freeway" }
  | { kind: "clear" };
```

Active conditions persisted per lease in the store (`lease_conditions` table) so `warden release`, gc and a crashed spec process can undo them.

## Phases

### COND-1 — ✨ feat(core): lease-scoped condition store + undo-on-release
- `packages/core/src/conditions/conditions.types.ts` (unions above), `conditions.ts`: `recordCondition(store, leaseId, area, value)`, `clearConditions(store, leaseId)`, `activeConditions(store, leaseId)`; all inside `store.transaction` (BEGIN IMMEDIATE).
- Store migration: `lease_conditions(lease_id, area, json, set_at)`; area ∈ network|location|clock|permission|locale|a11y|battery.
- Undo hook: release / gc / shutdown call `undoConditions(deps, lease)` → driver resets (airplane off, `emu network speed full`/`delay none`, `http_proxy :0`, `location clear`, `dumpsys battery reset`, `font_scale 1.0`, kill proxy + tickers). Idempotent, never touches foreign devices.
- Tests first: `conditions.test.ts` (temp `WARDEN_HOME`), release path test asserting reset argv via injected exec.

### COND-2 — ✨ feat(e2e): driver `location` op (iOS + Android)
- `driver.types.ts`: `location(op: LocationCondition): DriverResult<void>`.
- iOS: argv builders in `driver/ios/simctl.ts` (pattern of `statusBarOverrideArgv`); long routes via stdin `-`.
- Android: `driver/android` `geo fix` (lon,lat order — test it), route ticker in `packages/e2e/src/conditions/route-ticker.ts`: great-circle interpolation by `speedMps`/`intervalS`, injected clock, cancellable; ticker pid/handle tracked so COND-1 undo stops it.
- `gpx.ts`: parse `<trkpt>`/`<wpt>`/`<rtept>` → points (no deps, tolerant parser). Bundled scenario waypoint sets for Android parity.
- Tests: argv builders, interpolation math (distance/bearing), GPX fixtures, fake-adb ticker with fake clock.

### COND-3 — ✨ feat(e2e): Android native network (speed / delay / offline)
- `network(op: NetworkCondition): DriverResult<NetworkState>` on driver.
- Preset table `network.presets.ts` → emu console values (edge/umts/lte/full etc) + proxy params for COND-4 (one table, both layers).
- Offline = airplane mode via `cmd connectivity`; verify with `dumpsys connectivity` before returning (no sleep-and-hope).
- Tests: fake-adb argv + state parse.

### COND-4 — ✨ feat(core): per-lease shaping proxy (Bun)
- `packages/core/src/netproxy/`: HTTP + HTTPS `CONNECT` tunnel (no MITM, no certs), token-bucket bandwidth up/down, latency + jitter per connection and per chunk, loss = random connection reset / stall, blackhole, `HostFault` rules by host glob (status codes only for plain HTTP; HTTPS gets reset/delay/blackhole).
- One proxy per lease, port from warden's port allocator, lifecycle owned by lease (COND-1 undo kills it).
- Live reconfig over a local control socket (so flap/timeline changes don't drop the listener).
- Android routing: `settings put global http_proxy 10.0.2.2:<port>` (emulator host alias), reset `:0`.
- Tests: in-process proxy against local Bun server measuring throughput/latency bounds, fault rules, reconfig.

### COND-5 — ✨ feat(e2e): iOS per-app proxy routing + offline signal
- Native: small dylib in `packages/e2e/native/ios` swizzling `URLSessionConfiguration.default/.ephemeral` `connectionProxyDictionary` → `127.0.0.1:<port>` read from env `WARDEN_NET_PROXY`; injected via `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` at launch (only when a network condition is active, else zero overhead).
- Covers URLSession (RN fetch/XHR/images, most SDKs). Not covered: raw sockets / `NWConnection` — documented limitation.
- Offline signal for app UI (NetInfo / NWPathMonitor still says online on sim): dylib also posts a fake path status when `WARDEN_NET_OFFLINE` control flag set (via control socket / Darwin notify). JS fallback: devtools CDP shim emitting NetInfo change for RN (reuse `network.script.ts` pattern, plain ES2015).
- Changing network mid-test on iOS = proxy reconfig, no relaunch; enabling the first time requires launch with dylib (spec API launches with it if suite declares `conditions.network`, else `E_NETWORK_RELAUNCH` with hint).
- `native` signoff check runs (touches `packages/e2e/native/**`).

### COND-6 — ✨ feat(e2e): flap + timeline scheduler
- `conditions/scheduler.ts`: `flap` (alternate up/down with jitter) and `timeline([{ atMs, network?, location? }])`; injected clock; runs in spec process for specs, in a detached `warden` child for `warden ui` (tracked in `lease_conditions`, killed on undo).
- Every transition written to `results.jsonl` as `condition` events so failures show what network/location was active (evidence rule).

### COND-7 — ✨ feat(e2e): spec API + config
- `device.network.set(cond)`, `device.network.during(cond, fn)` (scoped, restores previous even on throw), `device.network.flap(opts)`, `device.network.fault(rule)`, `device.network.status()`, `device.network.reset()`.
- `device.location.set({ lat, lon })`, `device.location.route(points | { gpx }, opts)`, `device.location.scenario(name)`, `device.location.clear()`.
- `device.timeline([...])`.
- `warden.config.ts` suite/profile key `conditions: { network?, location?, permissions?, locale?, timezone?, a11y? }` applied at session start (permissions before install/launch).
- Auto-reset between specs in a suite (each spec starts from suite baseline).
- Tests: `device.test.ts` round-trips against `driver.testing.ts` fake.

### COND-8 — ✨ feat(cli): `warden ui` verbs + skill + changeset
- `warden ui network` is a group (user, 2026-10-29): `warden ui network log [n] [--since] [--grep]` = the existing devtools request log (old bare `warden ui network [n]` kept as a hidden deprecated alias, so the bump stays minor); `warden ui network set <online|offline|edge|3g|4g|lte|wifi|slow|lossy> [--latency ms] [--jitter ms] [--down kbps] [--up kbps] [--loss pct]`, `warden ui network flap --up 10s --down 3s`, `warden ui network fault <host> <status:503|reset|delay:2s|blackhole>`, `warden ui network status|reset`.
- `warden ui location set <lat,lon>`, `warden ui location route <lat,lon>... [--speed m/s] [--interval s] [--loop]`, `warden ui location gpx <file>`, `warden ui location scenario <name>`, `warden ui location clear`.
- No MCP tools (same reason as BIO-4: device verbs bypass leases).
- Skill: `skills/warden/references/ui.md`, `specs.md`, `suites.md`, `troubleshooting.md` (append entries, never renumber) + SKILL.md quick-ref line. `.changeset/device-conditions.md` → `"@delacour/warden": minor`.
- Verify: `cd apps/cli && bun test src/skill-coverage.test.ts src/skill.test.ts`.

### COND-9 — ✨ feat: extra conditions (permissions, locale/tz, a11y, battery, memory, push)
- Driver ops + spec API + `warden ui` verbs: `device.permissions.set({ location: "granted"|"denied"|"unset", camera, photos, contacts, notifications, microphone })`, `device.timezone(tz)`, `device.locale(tag)`, `device.a11y({ textSize, boldText?, contrast?, reduceMotion? })`, `device.battery({ level, charging })` (Android real, iOS status bar only), `device.memoryWarning()`, `device.push(payload)` (iOS only).
- Each one recorded in `lease_conditions` + undone on release.
- Verify every mechanism in the table on real sim/emu before wiring; drop any that doesn't work (e.g. iOS `lowmemory` notify) rather than fake it.

### COND-10 — ✅ test: example app + specs + docs
- `apps/example`: Conditions screen — NetInfo state, fetch with timing/timeouts/retry, `expo-location` live coords + geofence enter/exit text, permission state.
- Specs: `network-offline.e2e.ts` (cold start offline → banner → online → recovers), `network-slow.e2e.ts` (3g → skeleton visible, request > 1 s), `network-flaky.e2e.ts` (flap → retry succeeds), `network-fault.e2e.ts` (503 → error UI), `location-route.e2e.ts` (route crosses geofence → "Entered"), `location-denied.e2e.ts`.
- `warden e2e example` green on iOS + Android. Docs: `apps/docs/content/docs/e2e/conditions.mdx`.

### COND-12 — ✨ feat: mock clock / time travel
- Model: `ClockCondition = { kind: "real" } | { kind: "offset"; ms: number } | { kind: "fixed"; at: string /* ISO */ } | { kind: "frozen"; at: string }`.
- iOS sim (sim reads host clock, no per-sim time): same COND-5 dylib interposes `clock_gettime`, `gettimeofday`, `time`, `CFAbsoluteTimeGetCurrent`, `mach_continuous_time` stays real (monotonic untouched so timers/animations don't break). Offset read from env `WARDEN_CLOCK_OFFSET_MS` at launch, live-changed over the COND-5 control channel (time travel mid-test without relaunch). Covers Hermes `Date.now()` (uses `clock_gettime`).
- Android emu: `settings put global auto_time 0` + `cmd alarm set-time <epochMs>` (fallback `adb root` + `date`), per-emulator; undo = `auto_time 1` + `cmd alarm set-time <host now>`.
- Spec API: `device.clock.set(iso)`, `device.clock.advance("2d")`, `device.clock.during(...)`, `device.clock.reset()`; suite `conditions.clock`. CLI: `warden ui clock set <iso>|advance <dur>|status|reset`.
- Undo on release (COND-1 area `clock`). Wall-clock only; monotonic clocks never shifted. Document: TLS cert validity breaks on large offsets (advance > cert expiry → HTTPS fails, expected).
- Tests: argv builders, dylib offset unit test (Swift), spec API round-trip, example spec "trial expires after 14 days" (advance 15d → "Expired").

### COND-11 — 🚧 stretch: exclusive host-network mode (iOS full-stack shaping)
- Opt-in `warden claim ios --host-network` takes an exclusive machine lease, applies `dnctl`/`pfctl` (sudo prompt), covers raw sockets. Refuses when any other sim lease is active. Off by default; may be dropped.

## Decisions (2026-10-29)
- iOS network = per-app proxy (dylib + per-lease proxy + NetInfo shim). No host-wide shaping by default.
- CLI verbs under `warden ui network` (a group: `log`, `set`, `flap`, `fault`, `status`, `reset`) / `warden ui location` / `warden ui clock` (+ COND-9 verbs under `warden ui`).
- Scope v1 = COND-1..10 + COND-12 (mock clock). COND-11 deferred.
- Implement on `feature/driftfish`, commit per phase, no PR (user, 2026-10-29). Parallel phases in sibling worktrees `~/orca/workspaces/warden/driftfish-<phase>` made by hand at branch head, merged `--ff-only`/rebase.

## Order / parallelism
COND-1 → (COND-2 ∥ COND-3 ∥ COND-4) → COND-5 → (COND-6 ∥ COND-12) → COND-7 → COND-8 → COND-9 → COND-10. One branch (`feature/driftfish`), subagent per phase, no GH issues. `native` signoff check needed from COND-5.

## Best-practice test scenarios this unlocks
- Network: cold start offline, drop mid-request, slow first byte (timeout tuning), high latency + low bandwidth (skeletons, image fallbacks), flapping (retry/backoff, no duplicate POSTs → idempotency keys), 5xx/reset per host, captive-portal-like blackhole.
- Location: permission denied / revoked mid-session, teleport jumps (sanity filters), geofence enter/exit, background updates during route, stale last fix after clear.
