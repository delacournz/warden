# WDN-GES: `warden ui screen` / `warden ui gesture`

## Release note (breaking)

CLI renames, no aliases (the old names fail as unknown commands):

| Old | New |
|---|---|
| `warden ui rotate [o]` | `warden ui screen rotate [o]` |
| `warden ui appearance [m]` | `warden ui screen appearance [m]` |
| `warden ui screenshot [path]` | `warden ui screen screenshot [path]` |
| `warden ui video start\|stop` | `warden ui screen video start\|stop` |
| `warden ui swipe …` | `warden ui gesture swipe …` |
| `warden ui longpress …` | `warden ui gesture longpress …` |

New: `warden ui gesture pinch|rotate|path`, `screen.gesture.*` and `locator.pinch/rotate` in specs. `--json` `command` is now e.g. `"gesture pinch"`; recorder actions are `screen-*` / `gesture-*`.

Flows are format v2 (`kind: "screen" | "gesture"` + `type`). v1 files still load and migrate on read; writes are always v2, so older warden versions cannot read flows saved by this one.

Related: [wdn-e2e.md](wdn-e2e.md).

## Context
Agents driving sims through `warden ui`, and `*.e2e.ts` specs, can't pinch, rotate or trace multi-finger paths today.
- The iOS driver already has `Driver.pinch()` (idb `.twoFingerTouch`), but neither the CLI nor the spec API exposes it.
- Android returns `E_UNSUPPORTED`.
- There is no free-form touch-path primitive.

`warden ui rotate` already means device orientation, so the CLI is regrouped into two namespaces:
- **`warden ui screen …`** for the device screen.
- **`warden ui gesture …`** for touch.

The same verb works in both: `screen rotate landscape-left` and `gesture rotate @e3 45`. This is a breaking move: the old top-level names are removed, with no aliases.

Research capped the finger count at **2 on both platforms**, with fingers going down and lifting together:
- dtuhidd `IndigoDigitizerEvent`, the Xcode 27 default, has only `pointOne` and `pointTwo` and a single shared phase.
- Xcode 27 suppresses legacy Indigo touch.

Platform implementations:
- iOS stays on idb `SimulatorHIDEvent`.
- Android gets a multi-pointer `MotionEvent` op in `warden-uiad`.
- TS owns all geometry and timing. Native code only replays resampled frames.

### Command tree after the change
```
warden ui screen   rotate [orientation] | appearance [light|dark] | screenshot [path] | video start [path]|stop
warden ui gesture  pinch [target] <scale> | rotate [target] <degrees> | path --path 'x,y …' [--path …]
                   | swipe <dir|x1 y1 x2 y2> [--from] | longpress <target> [ms]
top level (unchanged): status close snapshot find open press/tap fill type key scroll alert home back
                       wait is get record replay export eval tree logs network reload bench
```

### Spec API
- `screen.gesture.pinch({scale, center?, radius?, durationMs?})`
- `screen.gesture.rotate({degrees, …})`
- `screen.gesture.path({paths, durationMs?})`
- `screen.gesture.swipe(ScreenSwipeOptions)`: same implementation as `screen.swipe`, which stays
- `locator.pinch(scale, opts?)` and `locator.rotate(degrees, opts?)`

Device orientation stays `device.orientation()`.

### Flows v2 (`FLOW_VERSION = 2`)
- Steps use kind + type, mirroring the CLI:
  - `{kind:"screen", type:"rotate"|"appearance"|"screenshot", …}`
  - `{kind:"gesture", type:"swipe"|"longpress"|"pinch"|"rotate"|"path", …}`
  - All other kinds are unchanged.
- v1 files migrate on read; writes are always v2. The mapping:
  - `rotate` → screen/rotate
  - `appearance` → screen/appearance
  - `screenshot` → screen/screenshot
  - `swipe` → gesture/swipe
  - `longpress` → gesture/longpress
- Recorder action names: `screen-rotate`, `screen-appearance`, `screen-screenshot`, `gesture-swipe`, `gesture-longpress`, `gesture-pinch`, `gesture-rotate`, `gesture-path`.

### Other decisions
- Old CLI names get the plain commander "unknown command" error, with no stub.
- `home`, `back` and `alert` stay top-level.

## Team `wdn-ges`: waves of parallel subagents, one commit per phase, one PR to main

### Wave 1 (blocking)

**GES-1 — ✨ feat(driver): gesture contract + shared geometry**
- `packages/e2e/src/driver/driver.types.ts`:
  - Add `DriverCapabilities.maxPointers: 0|1|2`.
  - Add `TouchPoint = Point & {t?}` and `TouchPath = {points: readonly TouchPoint[]}`.
  - Add `GestureOptions {durationMs?, holdMs?, releaseMs?}` and `TwoFingerOptions {durationMs?, radius?, angle?}`.
  - Widen `pinch` to take `TwoFingerOptions`.
  - New method `rotate(center, degrees, opts?)`; positive degrees turn clockwise.
  - New method `gesture(paths, opts?)`.
- New `driver/gesture-geometry.ts`, pure functions:
  - `planGesture(paths, opts, maxPointers) → Result<GesturePlan, DriverError>`, where `GesturePlan = {paths: Point[][]; frameMs; holdMs; releaseMs; totalMs}`.
  - Untimed paths are timed by arc length over `durationMs` (default 300).
  - Resampling: about 16 ms per frame, at most 1000 frames, at most 60 s. A shorter path holds its last point. Coordinates are rounded to 0.01.
  - Also `twoFingerPaths`, `pinchPlan` and `rotatePlan`.
  - Bad input returns `E_BAD_REQUEST`. More paths than `maxPointers` returns `E_UNSUPPORTED`.
- `driver.testing.ts`:
  - Add `rotate` and `gesture` to the `DriverCall` cases.
  - Set `maxPointers: 2`.
  - The fake's `gesture` runs `planGesture`.
- Stub `rotate`/`gesture` as `E_UNSUPPORTED` in both real drivers.
- Update `docs/plans/wdn-e2e.md` (frozen contract: lines ~88, 98, 137–139, 181, 328) and `packages/e2e/AGENTS.md`.
- Tests first:
  - `gesture-geometry.test.ts`. Pinch endpoints must match the Swift test: centre (200,400), r 100, ×0.5 gives (100,400)/(300,400) → (150,400)/(250,400). Rotate 90° must follow an arc, not a chord.
  - `driver.testing.test.ts`.

### Wave 2 (parallel after GES-1)

**GES-2 — ✨ feat(simd): `gesture` op (iOS)**
- `native/ios/Sources/warden-simd/Ops/Input.swift`:
  - New `HIDPlan.gesture(paths:frame:hold:release:)`.
    - 1 finger: `.touch(.down)` frames.
    - 2 fingers: `.twoFingerTouch(.down)` frames.
    - `.delay` between frames, a final `.up`, the whole thing wrapped in `.composite`.
  - Wire format: `gesture{paths[[{x,y}]] (1–2 equal-length arrays, 1…1000 points), frameMs=16, holdMs=0, releaseMs=0, unit?}`.
  - Validation in `InputParams.paths` and `positiveMs`, returning `.badRequest`.
  - `geometry(unit)` resolves landscape once per op.
  - Register the op in `InputOps.names`. The existing `pinch` op is unchanged.
- XCTest in `InputTests.swift`:
  - frames for 1 and 2 fingers
  - hold and release
  - a single frame is a tap
  - `norm` checks landscape once
  - bad input is rejected
  - the op is registered
- `ios-driver.ts`:
  - `maxPointers: 2`.
  - `pinch` forwards `angle`.
  - `rotate` and `gesture` go through the plan to `sendGesture`, with timeout `gestureTimeout(totalMs)`.
  - Old helpers answer `E_BAD_REQUEST` matching `/unknown (input )?op/`. Map that to `E_UNSUPPORTED` with `reason:"helper_outdated"` and a restart hint, memoised like `rebind`.
- Tests: `ios-driver.test.ts`. Then `swift test --package-path packages/e2e/native/ios` and `bun run --cwd packages/e2e native:build`.

**GES-3 — ✨ feat(uiad): multi-pointer `gesture` op (Android)**
- `Uia.java gesture(paths, frameMs, holdMs, releaseMs)`:
  - Pointers: `PointerProperties` with id i and `TOOL_TYPE_FINGER`; `PointerCoords` with pressure 1 and size 1.
  - Event sequence: `ACTION_DOWN` → `ACTION_POINTER_DOWN|(1<<SHIFT)` → hold → `ACTION_MOVE` on an absolute schedule → release → `ACTION_POINTER_UP` → `ACTION_UP` (sync).
  - Failures:
    - If the first down fails, return `E_HID`. Nothing was injected, so the client may retry it on the fallback path.
    - If anything fails after that, send `ACTION_CANCEL` and return `E_INTERNAL`. This one is never re-injected.
  - Reply: `{frames, pointers, maxLagMs, via}`.
- `Main.java`: add the op case and bump `VERSION` to `0.3.0`.
- Regenerate and re-pin:
  - `bun run --cwd packages/e2e android:emit`.
  - Re-record the `record.ts` fixture on a leased emulator.
  - Update the `uiad-client.test.ts` version pin.
- TS side:
  - `uiad-ops.ts`: `gesture(plan)`.
  - `android-argv.ts`: `gestureMotionCommand(plan, maxMoves=12)`, the 1-finger `input motionevent` fallback.
  - `android-driver.ts`: `runGesture` tries uiad first. Without uiad, 2 fingers return `E_UNSUPPORTED` and 1 finger uses motionevent on sdk ≥ 26.
  - `pinch`, `rotate` and `gesture` go through the plans, with radius `100 × screen.scale` px. Remove `unsupported("pinch")`.
  - Capabilities with uiad: `{pinch: true, maxPointers: 2}`. Without uiad: `maxPointers` 1 or 0, by sdk.
- Tests:
  - `android-argv`, `uiad-ops`, `android-driver-uiad` and `android-driver` tests. `android-driver` replaces the old pinch `E_UNSUPPORTED` assertion.
  - `uiad-dex.test.ts` and `apps/cli/src/npm/e2e-bundle.test.ts`.

**GES-4 — ✨ feat(e2e): spec API `screen.gesture.*`, `locator.pinch/rotate`**
- `screen/actions.ts`:
  - `centreOf`.
  - `pinchRadius(rect, scale, screen)`: both finger ends stay inside the rect, with a minimum gap of 8% of the shorter side.
  - `rotateRadius`.
  - `requireGesture(driver, cap, verb)`: throws `E2eError("INVALID_ARGUMENT")`, following the `device.back()` precedent.
  - Constants: `PINCH_MS = 500`, `ROTATE_MS = 500`, `PATH_MS = 600`, `SCALE_RANGE = [0.1, 10]`, `MAX_ROTATE_DEGREES = 720`.
- `screen/locator.ts`: `pinch(scale, PinchOptions)` and `rotate(degrees, RotateOptions)`.
  - They mirror `swipe`: `assertOptions` → `act` → `actionable` → centre and radius from `visibleRect` → `rt.drive`.
- `screen/screen.ts`: `Screen.gesture: ScreenGestures`, with:
  - `pinch({scale, center?, radius?, durationMs?})`, defaulting to the screen centre.
  - `rotate({degrees, …})`.
  - `path({paths, durationMs?})`: no observe; validated against `maxPointers`.
  - `swipe(ScreenSwipeOptions)`: shares the `screen.swipe` implementation.
- Export the option types from `src/index.ts`.
- Tests: `locator.test.ts`, `screen.test.ts`, `actions.test.ts`, and the `observation.test.ts` input list.

**GES-5 — 💥 feat(cli): `warden ui screen` + `warden ui gesture` groups**

Regroup in `apps/cli/src/commands/ui.ts`:
- `const screen = cmd.command("screen")` takes `rotate`, `appearance`, `screenshot` and `video`. These are the existing handlers in `agent-ui/controls.ts` and `video.ts`, unchanged.
- `const gesture = cmd.command("gesture")` takes `swipe` and `longpress` (existing `actions.ts` handlers) plus the new `pinch`, `rotate` and `path`.
- Remove the old top-level registrations.
- Keep the dynamic imports, and update `startup.test.ts` to match.
- The `UiJson.command` becomes `"screen rotate"`, `"gesture pinch"` and so on. Check how `runUi` sets `command`.

New `apps/cli/src/agent-ui/gestures.ts`:
- `splitAmount(words, "scale"|"degrees")`: the last word is the amount; the rest is the target (`@eN`, a selector or `x y`), and an empty rest means the screen centre.
- `parsePaths`: points as `x,y`, separated by spaces or `;`; at least 2 points per path; bounds checked against `currentScreen()`.
- `gestureRegion`: `regionOf()` (`actions.ts:367`) generalised to also accept points.
- `requireCapability`: fails with exit 1, `details.driver:"E_UNSUPPORTED"` and a uiad hint.
- `uiGesturePinch`, `uiGestureRotate` and `uiGesturePath` all run through `runUi` → `finishAction`. That covers `--settle` and recording. The path is recorded as `args.paths "x,y x,y|x,y x,y"`.
- Rename the existing recorder action names in the same change: `controls.ts` (`rotate`/`appearance`/`screenshot` → `screen-*`) and `actions.ts` (`swipe`/`longpress` → `gesture-*`). `video` isn't recorded.

Options for the new commands:
- `pinch` and `rotate`: `--duration`, `--radius`, `--verify`, `--settle`. Negative degrees must parse; add a test.
- `path`: `--path` repeatable up to 2 times, `--duration`.

JSON results:
- pinch and rotate: `{action, target?, scale|degrees, center, radius, durationMs}`.
- path: `{action:"gesture-path", fingers, paths, durationMs}`.

Tests:
- Move the existing `ui-actions.test.ts` runs to the new argv: about 24 `run("swipe"|"longpress"|"rotate"|"appearance"|"screenshot"|"video", …)` calls.
- New `commands/ui-gestures.test.ts`.
- `ui.testing.ts` `HarnessOptions.capabilities?`.
- An assertion that the old top-level `ui rotate` and `ui swipe` are now unknown commands.
- `bun test -u apps/cli/src/__snapshots__/help.test.ts.snap` (via `help.test.ts`), then review the diff.

Search and update every other caller:
```
rg -n 'warden ui (rotate|appearance|screenshot|video|swipe|longpress)\b'
rg -n '`(rotate|appearance|screenshot|video|swipe|longpress)`'
```
This covers `controls.ts`, `actions.ts`, `video.ts` and `screen/actions.ts`, plus the help and hint strings in them. Bench adapters only use `snapshot` and `close`, so they are unaffected.

**GES-6 — ✨ feat(example): gesture playground screen**
- Route `apps/example/src/app/gestures.tsx`:
  - `Screen` + `Navbar` + `BackButton`, with a plain View body (no ScrollArea).
  - Reached through the deep link `warden-example://gestures` and a `settings-gestures` row.
- `src/modules/gestures/`:
  - `components/gesture-canvas.tsx`:
    - Accessible View with `testID="gestures-canvas"`.
    - RNGH `Gesture.Simultaneous(Pinch, Rotation, Pan.minPointers(2).maxPointers(2))` driving Reanimated values.
    - Values are committed in `onEnd` via `scheduleOnRN` or `runOnJS`.
  - `components/trace-pad.tsx`: a 1-finger Pan that measures path length.
  - `components/gesture-readouts.tsx`.
  - `hooks/use-gesture-readout.ts`.
  - `utils/readout.ts` and `readout.test.ts`.
- Readout testIDs:
  - `gestures-scale` (`toFixed(2)`)
  - `gestures-rotation` (degrees, clockwise positive)
  - `gestures-pan-x` and `gestures-pan-y` (fractions of the canvas size)
  - `gestures-pointers`
  - `gestures-trace-length`
  - `gestures-trace-end`
  - `gestures-reset`
- No comments inside JSX.
- Wiring:
  - `e2e/helpers/ids.ts`: add `gestures.*` and `settings.gestures`.
  - `e2e/helpers/flows.ts`: add `openGestures`.
  - `warden.config.ts`: add `AFFECTED.flows.gestures`.
  - `apps/example/AGENTS.md`: add a row for the screen.
- New spec `apps/example/e2e/gestures.e2e.ts`:

  | Gesture | Expected |
  |---|---|
  | `locator.pinch(2)` | scale > 1.4, pointers = 2 |
  | `pinch(0.5)` | scale < 0.75 |
  | `rotate(45)` then reset, then `rotate(-45)` | rotation within ±[30, 60] |
  | 2-finger `screen.gesture.path` | pan-x within [0.2, 0.4] |
  | 1-finger L path | trace-length > 1.0 |

### Wave 3 (after GES-4 and GES-5)

**GES-7 — 💥 feat(flows): flow v2, `screen` / `gesture` kinds**
- `flow.schema.ts`: set `FLOW_VERSION = 2` and replace the kinds `rotate`, `appearance`, `screenshot`, `swipe` and `longpress` with:
  - `screen`, discriminated on `type`:
    - `rotate {orientation}`
    - `appearance {mode}`
    - `screenshot {name?}`
  - `gesture`, discriminated on `type`:
    - `swipe {by:"direction"|"path", …}`, with the `swipeGestureSchema` fields flattened in
    - `longpress {target, durationMs?}`
    - `pinch {scale, target?, radius?, durationMs?}`
    - `rotate {degrees ≠ 0, target?, radius?, durationMs?}`
    - `path {paths: 1–2 × ≥2 points, durationMs?}`
  - Check the installed zod version supports a nested discriminated union. If it doesn't, use one flat union with a refine.
- New `flows/migrate.ts`: `migrateFlow(raw)` takes v1 to v2 (renames only), and the flow reader/`parseFlow` calls it before validating.
  - Test: `migrate.test.ts`, with a v1 fixture covering every renamed kind. It must round-trip to a v2 that is equal when checked through `stepSchema`.
- `replay.ts`: update `targetsOf`, `withTargets`, `describeStep` and the `ActMap` keys (the compiler forces these). Also update `replay.testing.ts`.
- `export.ts`:
  - screen steps produce `device.orientation/appearance/screenshot`, unchanged.
  - Gesture swipe produces `screen.gesture.swipe(...)`.
  - longpress produces `locator.longPress()`.
  - pinch/rotate with a selector target produce `locator.pinch(2)` / `locator.rotate(45)`.
  - pinch/rotate with coords produce `screen.gesture.pinch({scale, center})` plus a FIXME comment.
  - A path produces `screen.gesture.path({paths})`.
- `apps/cli/src/agent-ui/flow-sink.ts`: map the `screen-*` and `gesture-*` actions to steps.
- `flow-actors.ts`: factor `regionFor()` out of `swipeWithin`, then add the screen and gesture actors.
- Tests:
  - `flow.testing.ts` `allStepsFlow`
  - `flow.schema.test.ts`
  - `replay.test.ts`
  - the export golden: `UPDATE_GOLDEN=1 bun test src/flows/export.test.ts` in packages/e2e
  - a record → replay → export round trip in `ui-flows.test.ts`, plus replay of a checked-in v1 flow
- Bench and example: check `rg -l '"kind": *"(rotate|swipe|longpress|appearance|screenshot)"'` and migrate any checked-in `*.flow.json`.

**GES-8 — 📝 docs: docs site, skill, plan (new command tree everywhere)**
- `apps/docs/content/docs/guides/agent-ui.mdx`:
  - Device section (lines 48–49, 90–91) moves to `screen …`.
  - Acting table: add `gesture swipe|longpress|pinch|rotate|path`.
  - Line 147: flow wording.
  - Android section, lines 180–183: remove "no pinch" and add the uiad requirement.
  - Add a "screen vs gesture" explainer.
- `guides/specs.mdx`: `screen.gesture.*`, `locator.pinch/rotate` and `INVALID_ARGUMENT`.
- `reference/cli.mdx`: `warden ui` tables.
- `reference/e2e-driver.mdx`: Android support.
- `skills/warden/references/ui.md`:
  - Table rows (lines 70–82) move to the new groups.
  - Lines 164–166: drop "No pinch".
- `skills/warden/references/specs.md`: gesture rows.
- `skills/warden/references/troubleshooting.md` line 24: `gesture swipe`.
- `skills/warden/SKILL.md` and `rules/warden.md` (hand-driving verbs). The embedded skill is in `apps/cli/src/skill.ts`, so re-run its test.
- `docs/plans/wdn-e2e.md`, lines 137–139 and 314: the command table.
- Copy this plan to `docs/plans/wdn-gestures.md`, with a "breaking: CLI regroup" note for the release.

### Wave 4: verification

**GES-9 — ✅ test: gates + on-device**
1. `bun run typecheck && bun run check && bun run test`. Then `swift test --package-path packages/e2e/native/ios` and `bun run --cwd packages/e2e test`.
2. `bun run cli:link` and load the `warden` skill. Claim a device with `warden claim ios --json`, then:
   ```
   warden ui open warden-example://gestures --udid U
   warden ui gesture pinch id=gestures-canvas 2 --json   → get id=gestures-scale > 1.4
   warden ui gesture pinch id=gestures-canvas 0.5        → < 0.75
   warden ui gesture rotate id=gestures-canvas 45 / -45  → rotation ±[30,60]
   warden ui gesture path --path … --path …              → pan-x ≈ 0.3
   warden ui gesture path --path '<L on trace pad>'      → trace-length > 1.0
   warden ui screen rotate landscape-left / portrait     → still works under the new group
   warden ui screen screenshot / appearance dark         → still works
   warden ui rotate portrait                             → unknown command (exit 1)
   ```
3. Run `record start`, then the gestures, then `record stop`, `replay` and `export`, and inspect the generated spec. Finish with `warden ui close --release`.
4. Android: the same steps with `--serial`.
   - Run once with `WARDEN_ANDROID_UIAD=0`: 2 fingers should fail with `E_UNSUPPORTED`, and 1 finger should use motionevent.
   - `maxLagMs` should stay under about 16.
5. Run `warden e2e example --flows gestures`, then the same with `--platform android`. Run `warden e2e example --all` to check for regressions.
6. Native smoke runs:
   - `packages/e2e/native/scripts/smoke.ts`: add `rotate` and `gesture` steps.
   - `smoke-android.ts`.
   - `helper_outdated` against an old resident helper.
7. The rotation sign must match on iOS and Android, with clockwise positive. If it doesn't, fix the readout or the driver; don't loosen the spec.

## Critical files
- `packages/e2e/src/driver/{driver.types.ts, driver.testing.ts, gesture-geometry.ts (new)}`
- `packages/e2e/src/driver/ios/ios-driver.ts`
- `packages/e2e/native/ios/Sources/warden-simd/Ops/Input.swift`
- `packages/e2e/src/driver/android/{android-driver.ts, uiad-ops.ts, android-argv.ts}`
- `packages/e2e/native/android/src/nz/co/delacour/warden/uiad/{Uia.java, Main.java}`
- `packages/e2e/src/screen/{actions.ts, locator.ts, screen.ts}`, `src/index.ts`
- `packages/e2e/src/flows/{flow.schema.ts, migrate.ts (new), replay.ts, export.ts}`
- `apps/cli/src/commands/ui.ts`, `apps/cli/src/agent-ui/{gestures.ts (new), controls.ts, video.ts, actions.ts, flow-sink.ts, flow-actors.ts}`
- `apps/example/src/app/gestures.tsx`, `apps/example/src/modules/gestures/*`, `apps/example/e2e/gestures.e2e.ts`

## Risks
- **Breaking CLI change and flow v2.** External agents and scripts that call `warden ui rotate|appearance|screenshot|video|swipe|longpress` will break, and so will older warden versions that read v2 flows.
  - Mitigation: a release note, updated skill and docs, and v1 flows still read through migration.
- **Xcode 27 is unverified.** idb `.twoFingerTouch` over DTUHID is only proven through pinch. This Mac runs Xcode 26.6, so Indigo is the transport tested here.
- **Android API range.** Multi-pointer `injectInputEvent` is untested on API 26–36.
- **RNGH activation slop.** Hence the 500–600 ms default durations and the loose spec bounds.

## Unresolved questions
None. All answered: 2 fingers max, a full move with no aliases and a plain unknown-command error, flow v2 with kind+type and migration, `screen.gesture.*` + `screen.gesture.swipe`, home/back/alert stay top-level, and one PR.
