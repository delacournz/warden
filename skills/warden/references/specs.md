# Specs: `*.e2e.ts` with `@delacour/warden-e2e`

Read this to write or fix a spec. A spec is a `bun test` file. `warden e2e` runs it on leased devices (see `suites.md`). To explore the UI first, use `warden ui` (see `ui.md`). To create a spec from a driven session, use `warden ui record` (see `authoring.md`); it writes the file and you review it against this page.

## Install and preload

```bash
bun add -d @delacour/warden-e2e@<warden version>   # version must equal `warden --version`
```

- A version mismatch makes the preload exit 2 and print the `bun add -d @delacour/warden-e2e@<v>` fix.
- The preload registers the session and raises bun's timeout. It does nothing without `WARDEN_UDID`.
- Enable it for every `bun test` in `bunfig.toml`:

```toml
[test]
preload = ["@delacour/warden-e2e/preload"]
```

- Or pass `--preload @delacour/warden-e2e/preload` on each run (see "By hand").

## Layout

```
e2e/<spec>.e2e.ts        spec id = path under specsDir minus .e2e.ts (e2e/auth/sign-in.e2e.ts -> auth/sign-in)
e2e/helpers/ids.ts       export const ids = { ... } as const   (mirrors the app's testIDs)
e2e/helpers/steps.ts     shared steps (launch, signedIn, nextStep, openDeepLink)
e2e/helpers/poll.ts      pollUntil
```

## Imports

```ts
import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll, E2eError } from "@delacour/warden-e2e";
import type { App, Device, Screen, Locator, TestFixtures } from "@delacour/warden-e2e";
```

Other type exports: `OpenOptions OpenWaitUntil SystemAlerts DevicePerf PerfStartOptions PerfReport PerfBudgets PerfBreach LocatorReading TapOptions TapUntil PinchOptions RotateOptions ScreenGestures ScreenPinchOptions ScreenRotateOptions ScreenPathOptions`; value `WARDEN_E2E_VERSION`.

Never import subpaths (`/device`, `/screen/*`, `/env`). Only `.` and `./preload` are published. (The repo's example helpers use subpaths because the workspace exposes `./*`; copy the root type imports instead.)

## Test API

- `test(title, [options], async ({ app, device, screen, platform }) => ...)`
- `options`: `{ timeout, skip, only, platforms: ("ios"|"android")[], retry }`. `retry` is bun's retry; only the last attempt lands in `results.jsonl`.
- `test.skip`, `test.only`, `test.todo(title)`, `test.skipIf(cond)(title, body)`.
- `test.use({ timeout?, actionTimeout?, assertionTimeout?, launch?: "fresh" | "none", systemAlerts?: "accept" | "dismiss" | "off" })` applies to the file or the enclosing `describe`; put `timeout` above the tests it is for (after a test in the same scope it warns on stderr and that test keeps its old timeout). `systemAlerts` (default `"off"`): reads, actions and `expect` that see an alert on top answer it (`device.alert(mode)`, 3 answers max per look) and look again. Answers the app's own alerts too. `"dismiss"` answers iOS's "Open in …?" sheet with Open, and nothing is answered while `device.openLink` waits on a link (it owns the sheet).
- `test.extend<Extra>({ name: async (base, use) => { await use(value) } })` returns a `test` with the extra fixture.
- `describe(title, [{ serial }], body)`. `serial` is accepted but changes nothing (bun runs a file's tests in order).
- `beforeEach/afterEach` receive the base fixtures; `it.beforeEach/afterEach` on a `test.extend` result receive its fixtures too and run only for its tests. `beforeAll/afterAll` receive `app`, `device`, `screen`, `platform` only.
- The runner calls `app.open()` before every test unless `launch: "none"`. A spec starts from a fresh launch.
- Timeouts: test 120 s, action 30 s (`waitFor`, `scrollTo`, actions), assertion 5 s (`expect`). Precedence: test option, then `test.use`, then env (`WARDEN_E2E_*`). In a suite, set them under `spec`.

## Fixtures

### `app` (the app under test, `WARDEN_BUNDLE_ID`)

| Member | Does |
|---|---|
| `open({ url?, args?, env?, wait?: "quiet" \| "none" \| { until, timeout? } })` | terminate, relaunch with `WARDEN_LAUNCH_ARGS` + `args`, then open `url`; `wait: "quiet"` then polls (100 ms, 3 s max) until the screen has a visible control or testID (not the launch screen) and settles (250 ms quiet, 3 s max), never an error; `wait: { until: locator }` waits for the locator to be visible (`TIMEOUT` after `timeout`, default the assertion timeout) and settles once; default `"none"` |
| `close()` | terminate |
| `restart()` | relaunch with `WARDEN_LAUNCH_ARGS` |
| `reinstall()` | uninstall + install from `WARDEN_APP_PATH` (throws without it) |
| `clearData()` | wipe app data and keychain, keep the build |
| `isRunning()` | boolean |

### `device`

| Member | Does |
|---|---|
| `alert("accept" \| "dismiss" \| { button })` | answer the system alert on top; `false` when none; `ACTION_FAILED` for a missing named button |
| `openLink(url, { accept?, until?, waitMs? })` | open a URL from outside the app; presses "Open" on the iOS sheet (up to 3 times) and returns once the sheet is gone, or after ~1.4 s when none shows and the app is in front (later links with that scheme return as soon as the app is in front); `until: locator` returns when it is visible; `waitMs` (default 8000) caps the wait, no error |
| `home()` / `back()` | home key / Android back (iOS throws) |
| `orientation(set?)` | `"portrait" \| "portraitUpsideDown" \| "landscapeLeft" \| "landscapeRight"`; returns current |
| `appearance(set?)` | `"light" \| "dark"`; returns current |
| `clipboard()` / `setClipboard(text)` | read / write |
| `hideKeyboard()` | iOS presses Enter (may submit the field); Android presses back |
| `screenshot(name)` | saves `<attemptDir>/screenshots/NNN-<slug>.png`, returns the path |
| `snapshot({ interactiveOnly? })` | AX tree as text (same format as `warden ui snapshot`) |
| `settle({ quietMs = 250, timeout = 3000 })` | wait for a quiet UI; returns `{ quiet, waitedMs }`; hitting the deadline is not an error |
| `devtools` | `undefined` without `WARDEN_METRO_URL` (release build) |
| `perf` | `warden perf` from a spec, see below |

### `device.network` / `location` / `clock` / `timeline` (conditions)

Everything a test changes is put back when it ends, to the suite's `conditions` (`suites.md`). A change that fails throws the driver's code (`E_NETWORK_RELAUNCH`, `E_UNSUPPORTED` on a physical device). `Duration` = ms or `"10s"` / `"2m"` / `"2d"`. Each change is also a `condition` line in `results.jsonl`.

| Member | Does |
|---|---|
| `network.set(c, { relaunch? })` | `c`: `"online"`, `"offline"`, a preset (`"edge" "3g" "4g" "lte" "wifi" "slow" "lossy"`) or `{ kind: "custom", latencyMs?, jitterMs?, downKbps?, upKbps?, lossPct? }`. A running flap stops first. iOS: the app must carry the network dylib: a suite that declares `conditions.network` launches it that way, otherwise it fails `E_NETWORK_RELAUNCH` until you pass `{ relaunch: true }` |
| `network.during(c, fn, opts?)` | run `fn` under `c`, then put the previous condition (and flap) back, also when `fn` throws |
| `network.flap({ up, down, jitterPct?, seed?, base? })` | alternates `base` (default online) and offline until `stop()` or the end of the test; resolves once the first phase is in place; returns `{ stop(), done, status() }` |
| `network.fault(rule \| rules)` | `{ match: "api.*", action: { kind: "status", code: 503 } \| { kind: "reset" } \| { kind: "delay", ms } \| { kind: "blackhole" } }`; replaces the faults, `[]` clears; returns `{ notes }` (an `https://` request matching a `status` fault is reset, not answered) |
| `network.status()` | `{ condition, faults, flapping }` |
| `network.reset()` | stop the flap, clear faults, back to the suite's `conditions.network` (online without one) |
| `location.set({ lat, lon, altM? })` | a point |
| `location.route(points \| { gpx }, { speedMps?, intervalS?, loop? })` | waypoints `{ lat, lon }[]` or a GPX file (relative to the cwd); iOS plays it once (`loop` is `E_UNSUPPORTED`), Android ticks it until the next location call |
| `location.scenario("city-run" \| "city-bike" \| "freeway")` | bundled route |
| `location.clear()` | iOS clears; Android stops the ticker and keeps the last fix |
| `clock.set(at, { frozen? })` · `advance(by)` · `during(at, fn, opts?)` · `reset()` · `status()` | wall clock (`at`: ISO string, `Date`, epoch ms; `by`: `Duration`); `E_UNSUPPORTED` on a driver with no clock |
| `timeline([{ at, network?, location? }])` | plays steps from now (`at` = offset, a step takes a condition, not a flap); returns the same `ConditionRun` |

```ts
await device.network.during("offline", async () => {
	await screen.getByTestId(ids.todos.add).tap();
	await expect(screen.getByTestId(ids.banner.offline)).toBeVisible();
});
await device.network.fault({ match: "api.example.com", action: { kind: "status", code: 503 } });
await device.location.route([{ lat: 37.33, lon: -122.03 }, { lat: 37.34, lon: -122.03 }], { speedMps: 5 });
```

- Assert timing as an ordering with a margin (`slow > online + 50`), not an absolute: an open keep-alive connection keeps its cost, so a 3g request after an online warm-up pays one round trip, not a cold handshake.
- Only the wall clock moves. A JS timer armed while the clock was ahead waits for the shifted time after `clock.reset()`: re-read the time on demand or relaunch. A large offset breaks TLS (certificate dates).
- Grant a permission the test needs with `device.permissions.set` before `app.open()` instead of tapping through the prompt: iOS does not always raise it.

### `device.permissions` / `timezone` / `locale` / `a11y` / `battery` / `memoryWarning` / `push` (device settings)

Put back when the test ends (to the suite's `conditions.permissions` / `locale` / `timezone` / `a11y`), recorded on the lease like the conditions above, and each change is a `condition` line in `results.jsonl`. Set permissions before `app.open()`: iOS terminates a running app whose permission changes.

| Member | Does |
|---|---|
| `permissions.set({ location?, camera?, photos?, contacts?, notifications?, microphone?, … }, { bundleId? })` | each `"granted" \| "denied" \| "unset"`; names: `location locationAlways camera photos photosAdd contacts contactsLimited notifications microphone calendar reminders motion mediaLibrary siri`. Returns `{ bundleId, applied, skipped }` (`skipped` = no service on this platform, or the app does not declare it); none applicable throws `E_UNSUPPORTED`. Default app: the suite's |
| `permissions.reset({ bundleId? })` | every name this test set back to the suite's value, else `"unset"` |
| `timezone(tz \| null)` | IANA name (`"Asia/Tokyo"`); `null` puts it back. Android emulator: live, device-wide. iOS: `{ appliesOnLaunch: true }`, the app launched next gets it |
| `locale(tag \| null, { bundleId? })` | BCP 47 (`"fr-FR"`). Android 13+: per-app, live. iOS: applies to the app launched next |
| `a11y({ textSize?, boldText?, contrast?, reduceMotion? } \| null)` | `textSize`: a category name (`"accessibility-large"`) or a scale (`1.5`). iOS: text size + contrast. Android: text size + bold. Returns `{ applied, skipped, notes }`; only-skipped throws `E_UNSUPPORTED`; `null` resets |
| `battery({ level?, charging? } \| null)` | Android emulator: real. iOS: status bar only, result has `cosmetic: true`. `null` resets |
| `memoryWarning({ bundleId? })` | Android: critical trim to the running app. iOS: throws `E_UNSUPPORTED` |
| `push({ aps: { … } }, { bundleId? })` | iOS: delivers the payload to the app (4096 bytes max). Android: `E_UNSUPPORTED` |

```ts
await device.permissions.set({ location: "denied", notifications: "granted" });
await app.open();
await device.a11y({ textSize: "accessibility-large" });
await device.locale("fr-FR");
```

### `device.devtools` (dev client over Metro)

With `WARDEN_METRO_URL` set, `app.open()` attaches devtools in the background and keeps React Native's LogBox off (no warning/error toasts, no error inspector, fatals included) in every JS context, after relaunches and reloads too. Logs still land in `console.jsonl` and Metro's terminal. Assert on the app's own UI, never on a LogBox toast.

| Member | Does |
|---|---|
| `evaluate(expr)` | run JS in the app; returns a result object (`success`, `data` / `error`) |
| `reloadJs()` | reload the JS bundle |
| `tree()` | React component tree with rects (`devtools_unavailable` without the DevTools hook) |
| `network.entries()` / `clear()` | captured requests / drop them |
| `console.lines()` / `clear()` / `mark(label)` | captured console |
| `connect()` | the attached facet; throws `SESSION` when unreachable |

### `device.perf` (profile the app from a spec)

Shells out to the `warden` that started the run (`WARDEN_BIN`); by hand it throws `SESSION` ("device.perf unavailable"). One session per device at a time.

| Member | Does |
|---|---|
| `start({ js?, react?, native?: boolean \| "perfetto" \| "simpleperf", metrics?, frames?, logs?, all?, relaunch?, reset?, maxDurationMs? })` | open a session; no capture flag = warden's default set; `relaunch` arms captures then launches (startup recorded); `reset` = relaunch after wiping app data; `maxDurationMs` caps it (warden default 30 s, max 5 min). Returns `{ sessionId }` |
| `mark(label)` | label on the session timeline; commits, hangs and jank are tagged with the last mark |
| `stop({ budgets? })` | end it, return the `PerfReport` (`metrics`, `findings`, `marks`, `summary`, `reportPath`). Copies `report.json`, `report.md`, `session.json` to `<attemptDir>/perf/`. Throws `PERF_BUDGET` when over budget |
| `active` | a session this device opened and has not stopped |

Budgets (lower is better, all optional): `startupColdMs jankPct maxCommitMs p95CpuPct peakMemoryMb`. They come from the suite's `perf.budgets` in `warden.config.ts` (`WARDEN_PERF_BUDGETS`); `stop({ budgets })` replaces them per key. A metric whose capture did not run cannot breach. `warden e2e --perf <all|react,js,...>` records the captures for every attempt (`WARDEN_PERF`).

```ts
await device.perf.start({ react: true, metrics: true, relaunch: true });
await device.perf.mark("open list");
// ...drive...
const report = await device.perf.stop({ budgets: { maxCommitMs: 80 } });
```

### `screen` (queries are lazy until an action or assertion)

| Member | Does |
|---|---|
| `getByTestId(id, { visible? })` | by `testID` |
| `getByText(t, { exact?, visible? })` | by text |
| `getByLabel(t, opts)` / `getByPlaceholder(t, opts)` / `getByValue(t, opts)` | same options as `getByText` |
| `getByRole(role, nameOrOpts?, opts?)` | opts: `name exact checked disabled selected visible` |
| `locator("id=... label=... role=... nth=1")` | the `warden ui` selector grammar |
| `tapAt({ x, y })` | tap a point |
| `swipe({ direction, momentum? })` or `swipe({ from, to, durationMs? })` | `direction` up/down/left/right, `momentum` `"none" \| "slow" \| "fast"` |
| `scrollUntilVisible(locator, { direction = "down", momentum?, maxSwipes = 10, timeout? })` | scroll the screen |
| `screen.gesture.pinch({ scale, center?, radius?, durationMs? })` | 2 fingers; default centre = screen centre; scale > 1 zooms in; 0.1-10, not 1; 500 ms |
| `screen.gesture.rotate({ degrees, center?, radius?, durationMs? })` | 2 fingers; positive = clockwise; not 0, max 720; 500 ms |
| `screen.gesture.path({ paths, durationMs? })` | 1-2 finger paths (`Point[][]`), down and lift together; 600 ms |
| `screen.gesture.swipe(...)` | same as `swipe(...)` |

Roles: button link textbox searchbox checkbox radio switch slider image heading text tab tablist menu menuitem list listitem row alert dialog navigation group other.

`TextMatch = string | RegExp`. A string matches the whole text, case-sensitive, whitespace collapsed. `exact: false` makes it a case-insensitive substring.

### `Locator`

- **Scope:** `getBy*`, `locator()`, `filter({ hasText?, has? })`, `first()`, `last()`, `nth(i)`.
- **Reads (no waiting):** `count() all() text() allTexts() value() isVisible() isHidden() isEnabled() isChecked() boundingBox()`, and `read()` = `{ visible, text?, value?, checked? }` from one look (no match: `{ visible: false }`; `checked` only for switch/checkbox). Prefer it over several single reads.
- **Snapshot reuse:** the runner keeps the last whole-screen snapshot (iOS 150 ms, Android 1 s) and reuses it for the first look of a read or `expect` when nothing was done since (tap, key, launch, settle drop it). Actions that aim (`tap`, `longPress`, `fill`, `type`, `clear`, `press`, `scrollTo`) and `boundingBox` never reuse: they always take a new snapshot, so `expect(x).toBeVisible()` then `x.tap()` is two snapshots (a snapshot from a screen still sliding in has the wrong coordinates). `fill` confirm reads and `device.snapshot()` are always real.
- **Wait:** `waitFor({ state: "attached" | "detached" | "visible" | "hidden", timeout? })`. Default state is `visible`.
- **Actions** wait for exactly one visible match. Several matches fail with `LOCATOR_AMBIGUOUS`.
  - `tap({ position?, timeout?, until?, retries = 2, windowMs = 4000, pollMs = 250 })`, `longPress({ durationMs? })`. `until` (a locator that must be visible, or `async () => boolean`) makes the tap retrying: after each tap it polls for `windowMs`, re-taps when `until` did not hold. With a locator `until` a screen that changed after the tap counts as landed (no re-tap, however late `until` is), and an unchanged screen is re-tapped from 750 ms on. The last tap is not waited on (the next assertion reports what is missing). `retries`/`windowMs`/`pollMs` without `until` are `INVALID_ARGUMENT`. Replaces hand-written `tapUntil` helpers.
  - `fill(text, { via? })` empties the field, puts the text in, verifies on two reads, retries once. `via` is `"type"` (default, per key) or `"paste"` (iOS pastes with one Cmd+V, ~400 ms flat; falls back to typing if the pasteboard write fails; Xcode 27 syncs every sim's pasteboard with the Mac clipboard both ways, so a paste lands in clipboard history and on other sims, so avoid it on parallel runs and for secrets). The retry always types. Android always types. Secure fields are not verified.
  - `clear()`, `type(text)` (at the caret)
  - `press(key, { modifiers? })` sends a KEY (`Enter Backspace Tab Space Escape Delete Up Down Left Right`), it is not a tap. Use `tap()` to tap.
  - `swipe({ direction, momentum? })`, `scrollTo({ direction = "down", momentum?, maxSwipes = 10, timeout? })`
  - `pinch(scale, { durationMs?, radius?, timeout? })`, `rotate(degrees, { durationMs?, radius?, timeout? })` (positive = clockwise). Out-of-range `scale`/`degrees` and unsupported gestures throw `INVALID_ARGUMENT` (no `capabilities.pinch`, or more than `maxPointers` fingers; Android without `warden-uiad`: no pinch/rotate, 1-finger paths only): skip with `test({ platforms: ["ios"] })`.

## Matchers

`expect(locator)` polls every 100 ms for the first second, then every 250 ms. Any other value goes to bun's `expect`.

`toBeVisible toBeHidden toHaveText(t, { exact? }) toContainText(t, { ignoreCase? }) toHaveValue(v) toBeChecked({ checked? }) toBeEnabled toBeDisabled toHaveCount(n)`. All take `{ timeout? }`.

- Zero matches keep polling. Several matches fail at once (except `toHaveCount`).
- `.not` passes only after the inverted state held for 1000 ms (sooner on iOS/Android when the driver reports a quiet screen).
- `expect.soft(locator)` records the failure and the test fails when its body ends.
- Failures are `E2eError` with a `code`: `LOCATOR_NOT_FOUND LOCATOR_AMBIGUOUS INVALID_LOCATOR ACTION_FAILED TIMEOUT NOT_ACTIONABLE INVALID_ARGUMENT SESSION DRIVER ASSERTION PERF_BUDGET`. `E2eError` also carries `screen` (AX tree text at the failure, when known) and `matches` (count for `LOCATOR_AMBIGUOUS`).

## Example spec (`apps/example/e2e/todos.e2e.ts`)

```ts
import { expect, test } from "@delacour/warden-e2e";
import { signedIn } from "./helpers/steps";
import { ids } from "./helpers/ids";

test("add, complete and filter todos", async ({ device, screen }) => {
	await signedIn(device, screen);
	const remaining = screen.getByTestId(ids.todos.remaining);

	await screen.getByTestId(ids.todos.input).fill("Write e2e specs");
	await screen.getByTestId(ids.todos.add).tap();
	await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Write e2e specs");
	await expect(remaining).toHaveText("2 left");

	await screen.getByTestId(ids.todos.check("todo-1")).tap();
	await expect(screen.getByTestId(ids.todos.check("todo-1"))).toBeChecked();
	await expect(remaining).toHaveText("1 left");

	await screen.getByTestId(ids.todos.filter("active")).tap();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeVisible();
	await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeHidden();

	await screen.getByTestId(ids.todos.check("welcome")).tap();
	await expect(screen.getByTestId(ids.todos.empty)).toBeVisible();

	await screen.getByTestId(ids.todos.filter("done")).tap();
	await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeVisible();
	await expect(remaining).toHaveText("0 left");
});
```

## Helper patterns (`apps/example/e2e/helpers/steps.ts`)

The first press after a launch or navigation can be dropped, and a HID tap has no ack. So specs wait for the result and re-tap, with the built-in options instead of hand-written loops.

Every spec file starts with `test.use(SPEC_OPTIONS)`, where `SPEC_OPTIONS = { launch: "none", systemAlerts: "dismiss" }`: the spec opens the app itself, and a system sheet that covers the app is dismissed wherever a read, tap or assertion meets one.

```ts
export async function launch(app: Pick<App, "open">, screen: Screen): Promise<void> {
	await app.open({ wait: "quiet" });   // first content, then still (settle), never an error
	await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible({ timeout: 30_000 });
	// or in one call, settling on the welcome screen itself:
	// await app.open({ wait: { until: screen.getByTestId(ids.welcome.screen), timeout: 30_000 } });
}

await screen.getByTestId(ids.tabs.settings).tap({ until: screen.getByTestId(ids.settings.email) });   // 4 s a press, 2 re-sends
```

- `nextStep(screen, title)`: `tap({ until })` on the Next button, where `until` reads the title with `locator.read()` (`visible && text === title`), then `toHaveText`.
- `expectTodosAfterSignIn(screen)`: `toBeVisible({ timeout: 15_000 })`; `systemAlerts` dismisses a sheet meanwhile.
- `openDeepLink(device, screen, url, testId)`: up to 3 `device.openLink(url, { until, waitMs: 6_000 })`, checking the target screen after each.
- `pollUntil(read, accept, 10_000)` in `helpers/poll.ts` polls a read until `accept` likes it.
- Helpers take `App` / `Device` / `Screen` as parameters (`Pick` of what they use); import them as types from the package root.

## Accessibility rule

Specs read the accessibility tree, not React. A `testID` shows up only when the view is `accessible`. Keep switches and checkboxes real controls so `toBeChecked` works. Fix the component, not the spec. Inspect with `warden ui snapshot -i --udid <udid>`, `warden ui tree` (dev client), or `screen-at-failure.txt`.

## By hand

```bash
warden claim ios --json          # -> udid; install: warden app ensure ios --udid <udid>
WARDEN_UDID=<udid> WARDEN_BUNDLE_ID=<bundleId> \
  bun test --preload @delacour/warden-e2e/preload e2e/todos.e2e.ts
```

- The preload is mandatory unless `bunfig.toml` already has it.
- Optional env: `WARDEN_PLATFORM=android`, `WARDEN_METRO_URL` and `WARDEN_LAUNCH_ARGS` (JSON array) for a dev client (take both from `warden dev ios --json`), `WARDEN_E2E_OUT`, `WARDEN_E2E_TIMEOUT`, `WARDEN_E2E_ACTION_TIMEOUT`, `WARDEN_E2E_ASSERTION_TIMEOUT` (ms), `WARDEN_BIN` (JSON argv of warden; needed by `device.perf`), `WARDEN_PERF` / `WARDEN_PERF_BUDGETS`, `WARDEN_E2E_DEBUG=1` (log every helper op with its duration), `WARDEN_APP_PATH`, `WARDEN_SIMD_SOCKET`.
- Release the lease when done: `warden release <leaseId>`.

## Artifacts

`<out>/<specId>/<title-slug>-<hash6>/`. `<out>` is `WARDEN_E2E_OUT`, default `.warden-e2e/<ISO time>`. Under `warden e2e` it is `<batchDir>/e2e/<worker>-<seq>/`.

- Always: `trace.jsonl`, `screenshots/`.
- On failure: `failure.png`, `screen-at-failure.txt`, `native.log` (+ iOS `.ips` crash reports) best effort, plus `console.jsonl` and `network.jsonl` with devtools.
- With `device.perf` / `--perf`: `perf/report.json`, `perf/report.md`, `perf/session.json`.
- `<out>/results.jsonl`: one line per test (`file title status durationMs startedAt error? artifacts{dir,files} device`), status `passed | failed | skipped | timed-out`. `files` lists what was written into the attempt dir.
- Under `warden e2e` the batch dir also holds `e2e-report.json` (verdicts; `--report <file>` copies it).
- Read `screen-at-failure.txt` first: it is the full AX tree at the failure.

## Not in the API

These do not exist. Do not write them.

- `app.launch`, `app.openLink`, `app.reload` (use `app.open`, `device.openLink`, `device.devtools.reloadJs()`)
- `device.rotate` (use `device.orientation`)
- `screen.rotate` / `screen.pinch` (use `screen.gesture.rotate` / `screen.gesture.pinch`; orientation is `device.orientation`)
- `toBeHittable`
- locator `scroll` / `scrollUntil` (use `locator.scrollTo()` or `screen.scrollUntilVisible()`)
- `agent.*`

## Don'ts

- No fixed sleeps. Use matchers, `waitFor`, `settle`, or a poll helper.
- No fixed Metro port and no hand-started Metro. `warden dev` and the suite's `metro` own it.
- No `WARDEN_*` exports for a suite run. `warden e2e` sets them.
- No `test.only` left in. Under `CI` it fails the run.
- No subpath imports.
- No `page`, `agent-device`, `argent` or tester.army APIs.
