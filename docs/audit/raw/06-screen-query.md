# 06 · screen-query (auditor 06)

Scope: `packages/e2e/src/screen/{locator,query,queries,nodes,roles,text,selector,render,react-locator,screen}.ts`, their tests and testing helpers, and `packages/e2e/src/driver/observation-cache.ts`. Commit `dfcc68b`. All 465 owned tests pass (`bun test` over the 18 owned test files).

## Top 5 by impact

1. **06-1**: actions aim from one fresh snapshot and never check that the target stopped moving. The "never reuse" rule (`5115432`) only narrows the mis-tap race of `wdn-perf.md:96`. It does not close it.
2. **06-2**: assert-then-tap costs two snapshots, about 45 pairs per rep. A snapshot stamped as quiet could serve the action and save up to about 3.4 s per rep on iOS and 2.2 s on Android (estimated upper bound).
3. **06-4**: on a dev client, the React tree is read on every no-match poll of every plain `getByTestId` action. That includes actions that can never use it, and the read runs while the app is still drawing the screen being waited for.
4. **06-7**: the reuse window is set per platform, not by what a read costs. Android keeps snapshots for 1 s while a `warden-uiad` read takes about 50 ms, and the age is counted from when the snapshot arrived.
5. **06-6**: on Android, an alert-button press can aim from a kept snapshot up to 1 s old, which gets around "actions never reuse".

## Findings

### 06-1 Actions aim from a single fresh snapshot with no stability check: the mis-tap race is narrowed, not closed
- Category: flake-risk
- Severity: P1
- Known?: new (it is the class of bug in `docs/plans/wdn-perf.md:96@dfcc68b`. The fix `5115432` landed, see below, but it addresses snapshot age only)
- Evidence:
  - `packages/e2e/src/screen/locator.ts:384-406@dfcc68b` (`actionable`): each poll calls `tryObserve({ reuse: false })`. The first poll where the one match is visible, enabled and has its tap point on screen returns `{ entry, observed }`, and `tapOnce` (`locator.ts:455-465@dfcc68b`) taps `tapPointOf(found.entry)` from that snapshot. `blockedReason` (`locator.ts:791-798@dfcc68b`) checks visible, disabled and on-screen. Nothing checks that the frame is the same as in an earlier look.
  - The doc comment at `locator.ts:380-382@dfcc68b` says "the action goes to where the element is now". That holds only if the screen has stopped. A fresh snapshot also describes the screen at capture time. When the tap lands, that capture is one snapshot latency plus the tap RPC old. On iOS the average snapshot is 13.0 s / 170 = 76 ms (`docs/bench/ios-2026-10-16-perf.md:141@dfcc68b`), and reads take 100-300 ms (`observation-cache.ts:16@dfcc68b`). That is the same order as the 150 ms cache age that mis-tapped 3 of 32 tests (`wdn-perf.md:96@dfcc68b`).
  - The test that pins the fix models a screen with only two positions, where the second look is already settled: `slidingIn` in `observation.test.ts:116-135@dfcc68b` (y 300, then 600 forever). A three-position slide (300 → 450 → 600) would show the tap going to 450. No test covers a fresh-but-moving screen.
  - Interacting context: K15 (`app.open({wait:"quiet"})` returns while the welcome screen is still sliding in, `packages/e2e-bench/suites/warden/helpers/flows.ts:17-18@dfcc68b`).
- Impact: estimated. Every locator action (62 taps per rep, both platforms) is exposed while a transition is still running. The risk is highest on the first action after a navigation, about 5 per test in the bench suite. Today's 100% pass over 3 reps (`perf12-fix`, `wdn-perf.md:96`) shows the rate is low on that host, not that the race is gone.
- Proposed fix: Playwright's "stable" rule in `actionable`. Accept a match only when its frame, rounded to 1 pt, equals the frame in the previous look of the same generation. The previous look can be the kept snapshot of a read or assertion: give `Observes` an optional `previous()` that returns the last kept snapshot, never used to answer a read. This costs one extra snapshot (about 76 ms iOS, 50 ms Android) only when no same-generation look exists or the frame moved. Option B, cheaper, is 06-2's quiet stamp. Files: `screen/locator.ts`, `driver/observation-cache.ts`. Contract additive.
- Effort: M
- Risk: med. Under heavy load, taps right after an input pay about one more snapshot. Verify on a device.
- How to verify: add an `observation.test.ts` case with a three-position slide, where the tap must land at the settled position. Re-run `bun run bench run --frameworks warden --runs 3` on iOS and Android, and compare snapshots per rep and the `perf12-merged` style failure rate at high host load.
- Confidence: med
- Verified by: read; traced path from `Locator.tap` → `actionable` → `Runtime.tryObserve` → `observe({reuse:false})` → `driver.tap`; ran `bun test` on the owned test files

### 06-2 Assert-then-tap is two snapshots: a snapshot stamped as quiet could let the action reuse the assertion's look
- Category: perf-latency
- Severity: P2
- Known?: new (bench "What changed": "The snapshot count did not move", `docs/bench/ios-2026-10-16-perf.md:138@dfcc68b`)
- Evidence:
  - Snapshots per rep: 170 on iOS (`ios-2026-10-16-perf.md:129`), 150-153 on Android (`android-2026-10-16-perf.md:124`), with 62 taps. Under the current rule about 62 of these are action looks: one per tap, fill, type and longPress (`locator.ts:392`). The other ~108 are reads and waits. Most of those follow an input: the first poll of an assertion after a tap, `tap({until})` checks every 250 ms (`locator.ts:472-493`), the later polls of waits, `openLink` polls, and fill confirm fallbacks (`locator.ts:681`). After an input the cache has nothing to give (`observation-cache.ts:101-107`), which is why the PERF-2.1 cache moved iOS by 0 and Android by −8 to −12%.
  - Pairs the cache could serve if reuse were safe: an assertion directly followed by an action with no input in between. Counted in `packages/e2e-bench/suites/warden/*.e2e.ts` and `helpers/flows.ts`: four in each `openSignIn` or onboarding (welcome → Next, Plan → Next, Test → Get started, sign-in screen → fill), times 8 tests, gives 32. Then 3 after `expectTodosAfterSignIn`, 1 in sign-in, 4 in todos, 3 in settings and 2 in todo-detail. Total about 45 per rep.
  - The action cannot take the kept snapshot today, and 06-1 explains why. A plain stability check (06-1, option A) needs a second look anyway, so it saves nothing here.
- Impact: estimated upper bound, assuming every pair could reuse: 45 × 76 ms ≈ 3.4 s per rep on iOS (0.43 s per test), and 45 × ~50 ms (`android-2026-10-16-perf.md:135`) ≈ 2.2 s per rep on Android. The real share depends on how many assertion snapshots are quiet, which needs a device.
- Proposed fix: the helper stamps each snapshot with how long the screen has been quiet. iOS `warden-simd` knows this from its quiescence stream. `warden-uiad` knows it from the time of the last accessibility event. Add it as an optional `quietForMs` on the snapshot reply. An action may use a kept snapshot of the same generation when `quietForMs ≥ 150` and the snapshot's age is under the max age. Otherwise it looks fresh, and 06-1 applies. Files: helper ops (owners 01/02/04), `driver/ios/normalize.ts` and `driver/android/uiad-ops.ts` (03/04/05), `observation-cache.ts` and `locator.ts`. `Snapshot` in `driver.types.ts` is frozen, so carry the field through an optional extension type (the `RepeatingKeys` pattern). Contract: wire (additive optional field).
- Effort: L
- Risk: med. A wrong quiet signal brings back the mis-tap. Needs a device.
- How to verify: a fake-driver test where a quiet-stamped kept snapshot serves the tap and an unstamped one does not. On a device, compare snapshots and taps per rep, and record the share of `observation: cached` span details on `tap` steps.
- Confidence: med
- Verified by: read; counted pairs in the bench suite; traced the generation rules in `observation-cache.ts`

### 06-3 The React tree match cache ignores input: a tap or `boundingBox` on a React-only match can use a rect up to 450 ms old, from before the last input
- Category: correctness
- Severity: P2
- Known?: new
- Evidence:
  - `packages/e2e/src/screen/context.ts:167-178@dfcc68b`: `reactMatches` returns `this.reactCache` when the key, which is only `s:<testId>` or `r:<regex>`, matches and fewer than `REACT_THROTTLE_MS = 450` (`context.ts:54`) have passed. Inputs do not invalidate it, and the observation generation does not key it.
  - Callers that promise a fresh aim: `tapOnce` → `actionable(..., true)` → `reactStep` → `reactCandidates` (`locator.ts:457-463`, `616-640`), and `boundingBox` ("Always a new snapshot", `locator.ts:329-338`). Both take the React rect from the cache.
  - Scenario: `await x.tap(); const box = await x.boundingBox()` within 450 ms returns the rect from before the tap. A `getByTestId("row-menu")` tapped on screen A and then on screen B within 450 ms taps A's rect. The test `locator.react.test.ts:182` ("at most every ~450 ms while polling") covers polls only.
- Impact: estimated. A wrong-element tap or a stale frame, only for React-only matches on a dev client with Metro (`fixtures.ts:19-28@dfcc68b`). Rare, but it is the exact bug class the "actions never reuse" rule was written to remove.
- Proposed fix: drop `reactCache` whenever the driver generation moves. Add an optional `generation(): number` to `Observes` and store it in the cache entry. Also let the first poll of an action, and `boundingBox`, skip the throttle. Files: `screen/context.ts` (owner 07), `driver/observation-cache.ts`, `screen/locator.ts`. Contract additive.
- Effort: S
- Risk: low. A React-only tap after an input costs one more tree read.
- How to verify: in `locator.react.test.ts`, tap, move the fake component's rect, then call `boundingBox` within 450 ms of fake time. Expect the new rect.
- Confidence: high
- Verified by: read; traced `tap` → `actionable` → `reactStep` → `Runtime.reactMatches`

### 06-4 Every no-match poll of a plain `getByTestId` action reads the React tree, including for actions that can never use it
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence:
  - `locator.ts:400-401@dfcc68b`: when `resolve` finds no AX match, `actionable` calls `reactStep`, which calls `reactCandidates`. That awaits `facet.tree(...)` (`react-locator.ts:152-169`) every time `allowReact` is false as well: `fill`, `clear`, `type`, `press`, `longPress` and `swipe` (`locator.ts:498, 518, 548, 570, 582, 598`). There the result is used only to pick the "exists only in the React tree" message (`locator.ts:625-626`).
  - The usual reason for no AX match is that the element has not been drawn yet, for example the first action after a navigation. So the tree is read during exactly the wait the poll exists for. The read is awaited inside the poll step. The next AX look is delayed by it, and the fiber walk and measure run on the app's JS thread while it renders.
  - Cost per read: target under 250 ms (`docs/plans/wdn-e2e.md:161@dfcc68b`), measure guard 1200 ms (`devtools/tree.script.ts:24`), call timeout 2000 ms (`context.ts:56`). Throttled to once per 450 ms (`context.ts:54`).
  - `single()` (`locator.ts:243`) also reads the tree before `text()`, `value()`, `isEnabled()` or `isChecked()` throws not-found. That is the failure path only.
- Impact: estimated, dev client only (`WARDEN_METRO_URL` set). An action that waits W ms for its element makes about ⌈W/450⌉ tree reads. It sees the element up to one tree read late: 250 ms at the target, up to 1.2-2 s at the guard and timeout. For example, a fill on a sign-in screen still sliding in, with W ≈ 300 ms, pays 1 tree read, about 250 ms. A release build pays nothing (`fixtures.ts:19-28`).
- Proposed fix: when `allowReact` is false, never read the tree in the poll. Read it once at timeout, only to choose the error message. When `allowReact` is true, consult the tree only after about 500 ms without an AX match, so an element that is only late is found by AX first. Files: `screen/locator.ts`. Contract additive. The error text is unchanged.
- Effort: S
- Risk: low. A React-only tap takes up to 500 ms longer to fire.
- How to verify: with fake devtools in `locator.react.test.ts`, assert that `fill` on an element appearing on the third poll calls `tree` 0 times. On a dev client, trace `fill` step times on the sign-in screen before and after.
- Confidence: med
- Verified by: read; traced `actionable` → `reactStep` → `reactMatches` → `locateByTestIdViaReact`

### 06-5 `devtools.evaluate` and `reloadJs` change the screen without moving the observation generation
- Category: correctness
- Severity: P2
- Known?: new
- Evidence:
  - The cache's soundness rests on "every layer that can change the screen ... shares the one driver" (`driver/observation-cache.ts:9-11@dfcc68b`). The JS runtime is such a layer, but it is not the driver. `device.devtools.evaluate` and `reloadJs` (`packages/e2e/src/device-devtools.ts:41-48@dfcc68b`) go straight to the CDP facet. No driver call is made, so no `moveOn()` runs (`observation-cache.ts:101-104`).
  - After `reloadJs()` the app returns to its first screen. A read within the max age (150 ms iOS, 1 s Android, `observation-cache.ts:17`) gets the pre-reload snapshot. For example `await device.devtools.reloadJs(); await screen.getByTestId("todos").isVisible()` returns `true`. The same applies to `evaluate("router.push(...)")` or a store reset. Assertions recover on their second poll. One-shot reads (`isVisible`, `read`, `count`, `text`) do not.
- Impact: estimated. A wrong answer from one-shot reads within 1 s on Android or 150 ms on iOS after a JS-side mutation. No bench test uses it. The risk is in user suites that drive state through `evaluate` (the docs' devtools flow).
- Proposed fix: `createDeviceDevtools` calls `driver.invalidateObservations()` (when `canObserve`) before and after `evaluate` and `reloadJs`. Files: `device-devtools.ts` (owner 09). Contract additive.
- Effort: S
- Risk: low. One extra snapshot after an evaluate.
- How to verify: a test with the cached fake driver and fake devtools: read, `reloadJs`, read again. Expect 2 snapshots.
- Confidence: high
- Verified by: read; traced `device.devtools.reloadJs` → `facet.reloadJs` (no driver call)

### 06-6 Android: an alert button is pressed at a frame read from a kept snapshot up to 1 s old
- Category: correctness
- Severity: P2
- Known?: new
- Evidence:
  - The Android driver has no `alertOn`, so `device.alert(action)` (`device.ts:165-181@dfcc68b`) → `readAlert("axbridge")` falls through to `readBoth` → `driver.alert()` (`alert-reader.ts:42, 62-69@dfcc68b`). On the cached driver that is `alertFromSnapshot` (`observation-cache.ts:135-149@dfcc68b`). It answers from `usable()`, meaning any kept snapshot of this generation younger than 1 s, counted from arrival. Then `pressAlertButton` taps `centre(button)` from that snapshot (`device.ts:120-122`).
  - So an input, the button press, is aimed from a reused snapshot. That is the one thing `5115432` ruled out for locator actions. It happens both for `systemAlerts` (`context.ts:126-128` → `answerSystemAlert` → `device.alert`) and for a direct `device.alert("accept")` after any read in the last second.
  - A dialog still scaling in, or one the app or OS already dismissed, gives a tap at stale coordinates, possibly on the app underneath.
- Impact: estimated. Rare: the Android bench shows 0 `device.alert` calls per rep (`android-2026-10-16-perf.md:125`). When it happens it is a wrong-element tap. A fresh read would cost about 10-50 ms (`packages/e2e/AGENTS.md:57`, `android-2026-10-16-perf.md:135`) per answered alert.
- Proposed fix: `alertFromSnapshot` serves a kept snapshot only when it is younger than a short window (about 150 ms, as on iOS) or was taken by the same `tryObserve` that saw the alert. Otherwise it reads fresh. Files: `driver/observation-cache.ts`, and possibly `device.ts` (09). Contract additive. The test `system-alerts.test.ts:183` ("answering costs no extra dump") keeps passing for the same-look case.
- Effort: S
- Risk: low
- How to verify: in `observation-cache.test.ts`, keep a snapshot, advance the fake clock by 500 ms, then call `alert()`. Expect a device read.
- Confidence: high
- Verified by: read; traced `device.alert` → `createAlertReader.readBoth` → cached `alert()` → `pressAlertButton`

### 06-7 The reuse window is set per platform, not by read cost, and is counted from arrival: Android keeps a snapshot for 1 s while a read costs about 50 ms
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `OBSERVATION_MAX_AGE_MS = { ios: 150, android: 1000 }` (`driver/observation-cache.ts:16-17@dfcc68b`). The comment and the plan (`wdn-perf.md:236@dfcc68b`) justify 1 s by "an Android dump takes ~1.9 s". Since PERF-3.3 the Android read is `warden-uiad`, about 50 ms (`android-2026-10-16-perf.md:135@dfcc68b`). Both backends report `backend: "uiautomator"` (`uiad-ops.ts:84`, `android-driver.ts:323`), so the cache cannot tell them apart.
  - The age is taken at arrival: `keep` sets `at: now()` (`observation-cache.ts:112`), and the test pins this (`observation-cache.test.ts:67`, "age counts from when the snapshot arrived"). The kept tree therefore describes the screen as it was max age plus capture time ago: up to about 1.05 s on Android with uiad, about 2.9 s with the dump fallback, and 150 + 100-300 ms on iOS.
  - A reuse saves at most one read (about 50 ms on Android), but exposes first polls and one-shot reads to a window 20 times longer. In that window the app can change by itself: a fetch resolves, a toast hides, a timer fires. That is the reason the max age exists (`observation-cache.ts:11`).
- Impact: estimated. Wrong one-shot reads in the window, and assertions that pass on their first poll against a screen up to 1 s old on Android. No measured failure.
- Proposed fix: record how long each snapshot took (`took = arrival − start`) in `Kept`. Use `maxAge = clamp(2 × took, 150, 1000)`, or count age from the start of the snapshot. That keeps the 1 s window for the dump fallback and gives uiad about 150 ms. Files: `driver/observation-cache.ts` and its test. Contract additive.
- Effort: S
- Risk: low. Slightly fewer cache hits on Android with uiad, at about 50 ms each.
- How to verify: update the unit test so a slow snapshot (fake clock) is kept longer than a fast one. Compare `observation: cached` counts per rep on Android before and after.
- Confidence: med
- Verified by: read; ran `bun test src/driver/observation-cache.test.ts`

### 06-8 Strictness throws on the first ambiguous poll of a wait: a transient duplicate during a transition ends the action
- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence:
  - Within polls: `actionable` (`locator.ts:402@dfcc68b`), `waitFor` (`locator.ts:364`), the `tap({until: locator})` check through `visibleIn` (`locator.ts:487` → `311-315`), and the matchers (`expect/matchers.ts:302@dfcc68b`, owner 07). Each calls `pickOne`, which throws `LOCATOR_AMBIGUOUS` on more than one match (`locator.ts:699-710`). That ends the wait at once, with no `{done:false}`.
  - Hidden nodes still match every query except `getByRole` and `visible: true` (`query.ts:43`). During a native-stack push or pop, both screens are in the AX tree. A testID used by a component that appears on both, such as a pushed-twice detail screen or a shared header, matches twice for the length of the transition and then once.
- Impact: estimated. An immediate failure where a short wait would pass. Not observed in the bench, whose testIDs are unique per screen. Exposed: user suites that reuse testIDs across stacked screens.
- Proposed fix: inside a poll, treat ambiguity as not-yet-done. Keep the last ambiguous state and throw `LOCATOR_AMBIGUOUS` at the deadline, or prefer the single visible match when exactly one is visible. Files: `screen/locator.ts`, `expect/matchers.ts` (07). Changes when users see the error, so `policy_change`.
- Effort: S
- Risk: med. A genuinely ambiguous locator now fails after the full timeout instead of at once.
- How to verify: a unit test where a fake screen shows two matches for one poll and then one. Expect the tap to succeed. On a device, take snapshots during a push and check whether the outgoing screen's nodes are present and hidden.
- Confidence: low
- Verified by: read

### 06-9 `locator("text=…")` selectors are neither innermost-filtered nor ranked in specs, while `warden ui` ranks them
- Category: dx
- Severity: P3
- Known?: new
- Evidence: selector queries are not in `ECHOED_KINDS` (`query.ts:78, 103@dfcc68b`; pinned by `query.test.ts:290-291`, "selectors are not innermost-filtered"), and `text=` is a substring match (`selector.ts:169-174`). The CLI picks with `pickMostSpecific`, which prefers visible, then more exact terms, then the smaller frame (`selector.ts:234-251`, `apps/cli/src/agent-ui/target.ts:130-133@dfcc68b`). A spec uses the strict `exactlyOne`. A selector an agent proved with `warden ui tap "text=Save"` therefore fails in a spec with `LOCATOR_AMBIGUOUS` on any RN host view that echoes the label. Exported flows emit `screen.locator(...)` for selectors such as `text=/regex/` (`flows/export.test.ts:96`).
- Impact: dx. A spec failure on its first run.
- Proposed fix: apply `innermostOnly` to selector queries that carry a `text` or `label` term, or document the difference in the selector docs. Files: `screen/query.ts`. Contract additive.
- Effort: S
- Risk: low
- How to verify: a `query.test.ts` case with an echoed label: `locator("label=Welcome")` gives one match.
- Confidence: high
- Verified by: read

### 06-10 Query-layer CPU per read is sub-millisecond: the host CPU gap is not in the screen layer
- Category: perf-cpu
- Severity: P3
- Known?: known-extended K12
- Evidence:
  - The index is built once per snapshot (`context.ts:104-110`, WeakMap). Subtree text is lazy (`nodes.ts:125-153`). Each read is one pass of `resolve` over about 150-190 entries (`query.ts:98-123`).
  - Small waste: `matchesText` rebuilds `new RegExp` for every node on every call and normalizes the needle for each node (`text.ts:16-25`). The traits `Set` is built twice per node (`nodes.ts:118`, `roles.ts:230`). `filter({has})` is O(S × N × depth) (`query.ts:108`, `nodes.ts:174-183`). The excerpt re-indexes, but only on failure (`render.ts:86` via `context.ts:186`).
- Impact: estimated. 190 nodes × about 1 µs per regex construct ≈ 0.2 ms per regex poll, against a 76 ms snapshot (under 0.3%). The 12.1% iOS host CPU (K12) must come from elsewhere: the snapshot path (wire parse, owners 02/03) or the sampler's attribution (K2).
- Proposed fix: compile each query's matcher once, cached by `Query` object in a WeakMap. Low priority.
- Effort: S
- Risk: low
- How to verify: a micro-benchmark of `resolve` on `fixtures.testing.ts` at 190 nodes.
- Confidence: med
- Verified by: read

### 06-11 The kept snapshot survives attempt and test boundaries
- Category: robustness
- Severity: P3
- Known?: new
- Evidence: there is one `cacheObservations` wrapper per session (`session.ts:200@dfcc68b`). Nothing invalidates it when an attempt or test starts. `invalidateObservations` has one caller, `forgetObservation` in `tap({until})` (`locator.ts:477`). When a retry attempt or the next test starts with a read, for example a `launch: "none"` suite whose first step is a read, the first poll can reuse the previous attempt's last snapshot within 150 ms or 1 s.
- Impact: estimated. Rare. A retry's first read sees the failed attempt's screen.
- Proposed fix: the session calls `invalidateObservations()` at attempt start. Files: `session.ts` (08). Contract additive.
- Effort: S
- Risk: low
- How to verify: a session test with two attempts and a fake clock. The first read of attempt 2 must hit the device.
- Confidence: med
- Verified by: read

## Known items

- **K15**, known-confirmed: the bench helper itself notes that the welcome screen can still be sliding in after `wait:"quiet"` (`flows.ts:17-18`). 06-1 (stability check) is the locator-side guard against that, and 06-2 would make the same quiet signal pay off.
- **K12**, known-extended (06-10): the screen and query layer spends under 1 ms of CPU per read. The host CPU gap is not here.
- **K2**, touched only by reference in 06-10: per-process attribution would settle where the CPU goes.
- Plan claims verified as landed:
  - PERF-2.2 lazy subtree text: `nodes.ts:125-153`. The eager spot at `nodes.ts:135-139` is gone.
  - Lazy excerpts: `pickOne` renders only when it throws (`locator.ts:699-710`), and the matchers do the same (`matchers.ts:302`). Covered by `excerpt.test.ts`.
  - PERF-2.1:
    - generation bump on every non-read member: `observation-cache.ts:48-62, 152-178`
    - per-platform max age: `:17`
    - first poll only: `locator.ts:357, 480`, `context.ts:154`, `matchers.ts:294`
    - field confirm bypass: `locator.ts:681`, and the Android `elementAtPoint` no longer caches (`android-driver.ts:351-359`)
    - `locator.read()` from one observation: `locator.ts:296-308`
  - `5115432`, actions and `boundingBox` never reuse: `locator.ts:332, 392`.
- Hotspot not present: the assignment's "`pickOne` ambiguity ranking (exact > substring > smallest frame > reading order)" exists only for `warden ui` (`selector.ts:234-251`). Spec `pickOne` is strict with no ranking (06-9).

## Gaps I could not assess here

- Whether iOS AX frames report intermediate positions during a native-stack slide, and how often a fresh actionable snapshot catches the target mid-move. On a sim: log `found.entry.element.frame` and the previous look's frame for each tap (debug env), run `bun run bench run --frameworks warden --runs 3` at host load above 15, and count taps whose frame differed from the previous look (06-1).
- The share of assertion snapshots taken while the screen was quiet (06-2): read `settle` state from `warden-simd` (`WARDEN_SIMD_TRACE=1`) and uiad event timestamps around each snapshot.
- Observation cache hit rate per rep: count `"observation":"cached"` span details in `trace.jsonl` of a bench rep, on iOS and Android (06-7).
- React tree read latency on the example dev client: time `warden ui tree` 20 times, and trace `fill` on the sign-in screen with and without `WARDEN_METRO_URL` (06-4).
- Where the 76 ms average iOS snapshot goes (guest walk about 30 ms warm per `wdn-e2e.md:25`, against RPC, JSON and zod parse): the answer decides whether a server-side query is worth it. It would not cut the snapshot count, only transport and parse (owners 02/03).

## Owned files not read

- `packages/e2e/src/screen/fixtures.testing.ts`, `element.testing.ts`: skimmed only through test use, not read in full.
- The bodies of `locator.test.ts`, `locator.span.test.ts`, `nodes.test.ts`, `render.test.ts`, `selector.test.ts`, `roles.test.ts`, `text.test.ts`, `queries.test.ts`, `screen.test.ts` and `react-locator.test.ts` were not read line by line. They were run (all pass) and grepped for coverage of the findings.
- `roles.ts:1-117` (role maps): skimmed.

## Questions for the user

1. Is a Playwright-style stability check (06-1, up to one extra snapshot of about 76 ms on taps right after an input) acceptable, or should the fix wait for the helper's quiet stamp (06-2), which costs nothing extra but is a wire change?

## Files read

- docs/audit/BRIEF.md, docs/audit/ASSIGN-06.md (and the first lines of the other ASSIGN files, for owners)
- docs/plans/wdn-perf.md (§ PERF-0.4 results, PERF-2.1/2.2/2.3/2.4, uiad notes), docs/plans/wdn-e2e.md (grep), docs/bench/ios-2026-10-16-perf.md, docs/bench/android-2026-10-16-perf.md (idiomatic sections)
- packages/e2e/src/driver/observation-cache.ts; observation-cache.test.ts (test names)
- packages/e2e/src/screen/{locator,context,query,queries,nodes,text,render,screen,react-locator,selector (163-251),roles (118-243),screen.testing}.ts
- packages/e2e/src/screen/{observation,locator.tap-until,locator.react,locator.read,system-alerts,excerpt}.test.ts (test names, observation.test.ts:100-165)
- packages/e2e/src/expect/matchers.ts:280-330; packages/e2e/src/session.ts:170-240; packages/e2e/src/fixtures.ts:1-60; packages/e2e/src/device.ts (85-185); packages/e2e/src/device-devtools.ts:36-50; packages/e2e/src/alert-reader.ts; packages/e2e/src/driver/traced-driver.ts:25-80; packages/e2e/src/driver/driver.types.ts:100-200; packages/e2e/src/driver/ios/ios-driver.ts:430-480; packages/e2e/src/driver/android/android-driver.ts:345-372; packages/e2e/src/devtools/tree.script.ts:15-40
- apps/cli/src/agent-ui/target.ts:128-136
- packages/e2e-bench/suites/warden/*.e2e.ts, helpers/flows.ts
