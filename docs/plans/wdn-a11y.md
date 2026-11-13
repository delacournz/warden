# WDN-A11Y — Screen readers + accessibility testing (VoiceOver / TalkBack)

Goal: specs (`*.e2e.ts`), `warden ui` and suites can (1) check what a screen reader would announce and in which order, (2) run accessibility audits (warden rules + XCUITest audit + Android ATF), (3) see live announcements, (4) run a **real TalkBack** session on Android emulators, (5) fake a screen-reader-on and set the remaining display settings (reduce motion, bold text, …) so apps take their accessible code paths. Every setting is lease-scoped and **undone on release**.

Branch: `feature/screen-reader-a11y` (fast-forwarded to `origin/develop` 26c8ce5e, so it includes the PHY XCUITest runner `packages/e2e/native/ios-runner`). Plan copy goes to `docs/plans/wdn-a11y.md` in the first commit.

## Decisions (user, 2026-10-30)
- v1 scope = A11Y-0..11 in one PR; A11Y-12 deferred.
- iOS `screenReader: true` = fake via ios-inject (`UIAccessibilityIsVoiceOverRunning` → YES), state `mode: "simulated"`.
- Audits fail on `error` only by default; `minSeverity: "warning"` opt-in per suite/call.
- Android reduce motion: default changes to **off** (driver restores `transition_animation_scale` to the device's original after `disableAnimations`; `reduceMotion: true` zeroes it). Behaviour change → changeset line.
- ATF ships as a separate lazily-pushed, shrunk `warden-atf.dex`.
- Spike A11Y-0 first, review findings, then waves with subagents in sibling worktrees; commit per phase, no PR until asked.

## Spike outcomes (A11Y-0, 2026-10-30) — override phase text below where they differ
Full evidence: `~/.claude/plans/wdn-a11y-0-findings.md`.
- **iOS settings (A11Y-6)**: all via `simctl spawn <udid> defaults write com.apple.Accessibility <Key> -bool YES`, applied **live** to a running app (no relaunch, no notify); undo = `defaults delete`. Keys: `ReduceMotionEnabled`, `EnhancedTextLegibilityEnabled` (bold), `EnhancedBackgroundContrastEnabled` (reduce transparency), `DarkenSystemColors` (increase contrast), `ButtonShapesEnabled`, `DifferentiateWithoutColor`, `IncreaseButtonLegibilityEnabled` (on/off labels).
- **iOS fake VoiceOver (A11Y-6)**: primary = `defaults write com.apple.Accessibility VoiceOverTouchEnabled -bool YES` (flips RN `isScreenReaderEnabled()` live, no effect on taps/snapshots). ios-inject interpose of `UIAccessibilityIsVoiceOverRunning` (+ `-framework UIKit`) is fallback only. State still `mode: "simulated"`.
- **iOS hint/actions/order (A11Y-1)**: source = ios-inject UIView-tree walk (label, hint, value, id, traits, frame, customActions, isAccessibilityElement, `accessibilityElements` order) ~0.48 s; merged into snapshot by identifier/frame only when `--a11y` / a11y APIs ask (inject must be loaded → load trigger extended to a11y use). warden-simd unchanged.
- **XCUITest audit (A11Y-4)**: works on sim against a running app via `XCUIApplication(bundleIdentifier:)`, ~2 s; not running → error -51 (check state first, return `skipped`). PHY runner must compile for sim: guard `volumeUp/volumeDown` with `#if !targetEnvironment(simulator)`; sim build 3.7–10 s, unsigned.
- **TalkBack (A11Y-7)**: preinstalled (TalkBack 17) on Play images; enable = 2 `settings put secure` cmds, ~0.65 s, no tutorial; pre-grant `POST_NOTIFICATIONS` to TalkBack; device must be unlocked. uiad must connect with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`; `uiautomator dump` fallback unbinds TalkBack ~1 s → TalkBack mode requires uiad (else `E_UNSUPPORTED`). Drive via `findFocus(FOCUS_ACCESSIBILITY)`, `ACTION_ACCESSIBILITY_FOCUS`, `ACTION_CLICK` on clickable ancestor, `ACTION_SCROLL_*` (raw swipe doesn't scroll).
- **TalkBack speech (A11Y-7)**: verbose log level is UI-only (TalkBack dev settings) → primary source = uiad `TYPE_VIEW_ACCESSIBILITY_FOCUSED` stream composed by the speech model (`source: "simulated"`); logcat parser used opportunistically when verbose logging is on (`source: "talkback"`). Optional `warden ui a11y talkback-verbose` helper drives the settings UI once per device (stretch).
- **ATF (A11Y-4)**: runs in uiad, checks 3–8 ms, hierarchy 11 ms–0.7 s; dex 33 KB → 4.84 MB unshrunk → ship as a **separate lazily-pushed `warden-atf.dex`** (R8/proguard shrink), keep ATF resource bundles (d8 drops them → `MissingResourceException`).
- **Announcements (A11Y-8)**: uiad sees `TYPE_ANNOUNCEMENT` + live-region changes without TalkBack ✅ (RN path re-verify in A11Y-10).
- **Android reduce motion (A11Y-6)**: RN 0.86 reads `transition_animation_scale`; the driver already zeroes all 3 scales on open → RN reduce-motion is **always true in e2e today**. Model `reduceMotion` against the driver's `disableAnimations` (apply after it, undo via driver's saved originals); document the existing default. High-contrast text + inversion apply live.
- **Blocker for A11Y-10**: example app `START_CLASS_NOT_FOUND` on Android emulator (also seen in WDN-COND) → add **A11Y-10a 🐛 fix(example): Android launch** before the suite.
- Process lesson: spike claims need `--ttl` (bare 5-min lease lapsed and gc shut the sim).

## Platform facts (what's possible)

| Capability | iOS simulator | Android emulator | Physical iPhone |
|---|---|---|---|
| Real screen reader | ❌ VoiceOver doesn't run in the sim | ✅ TalkBack (`com.google.android.marvin.talkback`) on Play images; check with `pm path` | VoiceOver exists but can't be toggled programmatically → out of scope (A11Y-12) |
| App believes screen reader on | 🔬 interpose `UIAccessibilityIsVoiceOverRunning` in ios-inject + post `UIAccessibilityVoiceOverStatusDidChangeNotification` | ✅ real TalkBack | ❌ |
| Spoken output | simulated (speech model, A11Y-2) | real: TalkBack logcat (🔬) + simulated | simulated |
| Audit | XCUITest `performAccessibilityAudit` (iOS 17+, sim OK) + warden rules | ATF in `warden-uiad` (🔬) + warden rules | XCUITest audit via PHY runner |
| Announcements / live regions | 🔬 interpose `UIAccessibilityPostNotification` in ios-inject | `TYPE_ANNOUNCEMENT` + live-region events in uiad (no TalkBack needed) | ❌ |
| Reduce motion / bold / transparency / button shapes / differentiate without colour | 🔬 `simctl spawn <udid> defaults write com.apple.Accessibility <Key>` + relaunch/notify | reduce motion: `settings put global animator_duration_scale 0` etc (clashes with driver's own scales, see A11Y-6); high-contrast text: `settings put secure high_text_contrast_enabled 1`; inversion: `accessibility_display_inversion_enabled` | ❌ |

🔬 = unverified, settled by A11Y-0.

### Known blockers (from code mapping)
- `warden-uiad` (`packages/e2e/native/android/src/nz/co/delacour/warden/uiad/Uia.java:88-104`) connects `UiAutomation` with flags `0` → **suppresses other accessibility services (TalkBack) while warden reads**. Needs `UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` (API 24+). The `uiautomator dump` fallback has the same problem (no fix → TalkBack mode requires uiad).
- iOS snapshot (warden-simd on idb `FBSimulatorAX`) has **no hint, custom actions, isAccessibilityElement, or reading order** (`native/ios/Sources/warden-simd/Model/ElementBuilder.swift:45-99`).
- Android parser drops `focusable`, `editable`, `longClickable`, `importantForAccessibility` (`packages/e2e/src/driver/android/uiautomator.ts:190-273,311-336`).
- With TalkBack on, a single tap only moves focus and a one-finger swipe navigates → `press`/`scroll` must switch to a11y actions (`ACTION_CLICK`, `ACTION_SCROLL_FORWARD`) via uiad.
- No a11y matchers (`packages/e2e/src/expect/matchers.ts:123-270`). The MCP has no ui/device tools, so A11Y adds none.

## Model

```ts
// packages/e2e/src/driver/driver.types.ts — Element gains:
a11y?: {
  hint?: string;
  actions?: readonly string[];      // custom actions (iOS) / node actions (Android)
  focusable?: boolean;              // screen-reader reachable
  important?: boolean;              // Android importantForAccessibility, iOS isAccessibilityElement
  a11yFocused?: boolean;            // Android accessibility focus (TalkBack cursor)
  liveRegion?: "polite" | "assertive";
};

// packages/e2e/src/a11y/a11y.types.ts
type Announcement = { id: string; text: string; role: Role; parts: { label?: string; value?: string; role?: string; state: string[]; hint?: string } };
type A11yRuleId =
  | "missing-name" | "target-size" | "target-size-platform" | "duplicate-name" | "image-no-name"
  | "role-in-name" | "label-in-name" | "hidden-focusable" | "text-clipped" | "contrast" | "native";
type A11yIssue = {
  rule: A11yRuleId; severity: "error" | "warning"; wcag?: string;   // "2.5.8"
  source: "warden" | "xcuitest" | "atf"; elementId?: string; identifier?: string; message: string;
};
type A11yAuditResult = { issues: readonly A11yIssue[]; checked: number; sources: readonly A11yIssue["source"][]; skipped: readonly { source: string; reason: string }[] };

type ScreenReaderOp = { enabled: boolean };              // added to A11yOp as `screenReader?: boolean`
type ScreenReaderState =
  | { mode: "real"; engine: "talkback" }                  // Android
  | { mode: "simulated"; engine: "voiceover" }            // iOS inject flag
  | { mode: "off" };
```

`A11yCondition` (`packages/core/src/conditions/conditions.types.ts:88`) gains `screenReader`, `reduceMotion`, `boldText`, `reduceTransparency`, `buttonShapes`, `differentiateWithoutColor`, plus `previous` for Android `enabled_accessibility_services` so undo restores rather than deletes.

## Phases + waves

| Wave | Phases (parallel inside a wave) |
|---|---|
| W0 | A11Y-0 spike |
| W1 | A11Y-1 node model · A11Y-2 speech model · A11Y-6 display settings |
| W2 | A11Y-3 audit rules · A11Y-4 native audits · A11Y-8 announcements |
| W3 | A11Y-7 real TalkBack · A11Y-5 spec API + matchers |
| W4 | A11Y-9 CLI · A11Y-10 example + suite · A11Y-11 docs/skill/changeset |
| — | A11Y-12 physical VoiceOver (deferred) |

Execution: one sibling worktree per phase at branch head (`trevally-a11y-<n>`), subagent per phase, merge back per wave, commit per phase, no PR until asked. Every device step via `warden claim` / `warden ui` and release by lease id.

---

### A11Y-0 — 🔬 spike: settle the unknowns (findings doc, no shipping code)
Output: `~/.claude/plans/wdn-a11y-0-findings.md`, each item ✅/❌ with exact commands + timings. Claim one iOS sim and one Android emulator (`warden claim ios|android --json`), release by id after.
1. **iOS defaults keys**: toggle each in Settings > Accessibility, `simctl spawn <udid> defaults read com.apple.Accessibility`, record key names for Reduce Motion, Bold Text, Reduce Transparency, Button Shapes, Differentiate Without Colour, On/Off Labels. Then `defaults write` from clean state + relaunch the example app: does RN `AccessibilityInfo.isReduceMotionEnabled()` / `isBoldTextEnabled()` flip? Is a `notifyutil -p` post needed for a running app (try `com.apple.accessibility.cache.*`)?
2. **iOS fake VoiceOver**: in ios-inject, `__interpose` `UIAccessibilityIsVoiceOverRunning` → `YES` and post `UIAccessibilityVoiceOverStatusDidChangeNotification`. Does RN `AccessibilityInfo.isScreenReaderEnabled()` return true? Does it change anything in UIKit layout (it shouldn't)? Also try `defaults write com.apple.Accessibility VoiceOverTouchEnabled -bool YES` (expect no effect).
3. **iOS hint + actions + order**: can warden-simd's AX backends read `AXHint` / custom actions (FBSimulatorAX raw attributes, private `AXUIElement` attrs)? If not, can the PHY runner (`XCUIElement` snapshot has no hint) or ios-inject (walk `UIView` tree, `accessibilityHint`, `accessibilityCustomActions`, `accessibilityElements`) supply them? Pick one source.
4. **XCUITest audit on sim**: add a throwaway op to the PHY runner calling `performAccessibilityAudit(for: .all) { issue in record; return true }` against the example app. Record time, issue shape, whether the runner can target an already-running app (`XCUIApplication(bundleIdentifier:)`) without relaunch.
5. **TalkBack presence + enable**: `pm path com.google.android.marvin.talkback` on the local `google_apis_playstore_ps16k` AVD; enable via `settings put secure enabled_accessibility_services …/com.google.android.marvin.talkback.TalkBackService` + `accessibility_enabled 1`; how to skip the first-run tutorial (TalkBack prefs / `am start` intent / tap through).
6. **uiad suppression**: with TalkBack on, take a uiad snapshot → does TalkBack stop (`dumpsys accessibility` bound services)? Patch `connect(FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)` locally → does it survive? Does `uiautomator dump` kill it?
7. **TalkBack driving**: from uiad, `node.performAction(ACTION_ACCESSIBILITY_FOCUS)` then `ACTION_CLICK` with TalkBack on → does the app react? Read a11y focus via `findFocus(FOCUS_ACCESSIBILITY)`. Does `input keyevent` (Tab / Alt+arrows) move TalkBack focus?
8. **TalkBack speech capture**: enable TalkBack developer "log output level verbose" (find the shared-prefs key so it's scriptable), capture logcat for 3 focus moves, write the tag + regex that yields spoken strings. Fallback: uiad `AccessibilityEvent` stream (TYPE_VIEW_ACCESSIBILITY_FOCUSED + node text) as "what would be spoken".
9. **ATF in uiad**: can the ATF jar (Apache-2.0) be d8'd into the uiad dex, run `AccessibilityHierarchyAndroid` from a `UiAutomation` root node + screenshot? Dex size delta, run time on the example app's todos screen.
10. **Android announcements**: uiad `setOnAccessibilityEventListener` sees `TYPE_ANNOUNCEMENT` from RN `AccessibilityInfo.announceForAccessibility` without TalkBack?
11. **Android reduce motion**: does RN `isReduceMotionEnabled()` read `animator_duration_scale == 0`? How does that interact with the driver's own animation scales (grep `animation` in `packages/e2e/src/driver/android`)?

Done = findings doc with decisions for each 🔬 row. Any ❌ drops or reshapes the dependent phase (noted in findings).

### A11Y-1 — ✨ feat(e2e): richer accessibility node model
Depends: A11Y-0 (items 3, 6).
- `driver.types.ts`: add `Element.a11y` (Model above). Optional, so existing fixtures stay valid.
- Android: `uiautomator.ts` keep `focusable`, `editable`, `longClickable`, `importantForAccessibility` (uiad emits it; add to `Json.java` if missing), `accessibilityFocused`, `liveRegion`, action list (`AccessibilityNodeInfo.getActionList()` names) in uiad. Fallback dump: fill what XML has, leave rest undefined.
- uiad: `connect(FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES | …)` if A11Y-0.6 confirms (keep the flag only when the device's TalkBack is enabled? decide in A11Y-0).
- iOS: source picked in A11Y-0.3 for `hint` / `actions` / `important`; fold into warden-simd `ElementBuilder` or a separate inject read merged by `identifier`/frame.
- `screen/render.ts`: `snapshot -i --a11y` appends `hint="…"`, `actions=[…]`, `a11y-focused`.
- Tests first: parser fixtures (`uiautomator.test.ts`, Swift `ElementBuilderTests` with a hint fixture), render snapshot test.

### A11Y-2 — ✨ feat(e2e): speech + reading-order model (pure TS)
Depends: types from A11Y-1 only (agree the type in the first commit of W1).
- `packages/e2e/src/a11y/speech.ts`: `announce(el, platform): Announcement`.
  - VoiceOver order: label → value → role word ("button", "heading", "switch button", "adjustable", "link", "image") → state ("selected", "dimmed", "on"/"off", "expanded") → hint (after pause).
  - TalkBack order: state (checked/not checked) → label/text → role ("button", "switch", "heading", "double-tap to activate" style hint optional) → hint.
  - Name fallback: label ‖ text ‖ value ‖ child texts (merged descendants for non-focusable children, like both readers do).
- `packages/e2e/src/a11y/order.ts`: `readingOrder(snapshot, platform): Announcement[]` — only screen-reader-reachable nodes (`a11y.important !== false`, not hidden, has name or is actionable), grouped children merged into the focusable ancestor; iOS = tree order with row-major sort per container (VoiceOver's frame heuristic), Android = tree order (drawing order tie-break).
- Labelled **simulated** everywhere it surfaces (`source: "simulated"`).
- Tests first: fixture snapshots (iOS + Android) of the example settings screen → golden announcement lists. Include tricky cases: switch with label, image with no label, nested text in pressable, disabled button, heading.

### A11Y-3 — ✨ feat(e2e): warden audit rules
Depends: A11Y-1, A11Y-2.
- `packages/e2e/src/a11y/rules/*.ts`, one file per rule, each `(snapshot, ctx) => A11yIssue[]`:
  - `missing-name` (4.1.2, error): actionable or `focusable` with no computed name.
  - `image-no-name` (1.1.1): image role, `important !== false`, no name.
  - `target-size` (2.5.8, error < 24×24 pt/dp); `target-size-platform` (warning < 44pt iOS / 48dp Android).
  - `duplicate-name` (2.4.6, warning): two actionable nodes, same name, different frames, same screen.
  - `role-in-name` (warning): label contains "button"/"btn" (double announce).
  - `label-in-name` (2.5.3): visible text not contained in the accessible name.
  - `hidden-focusable`: `hidden`/off-screen node still in reading order.
  - `text-clipped` (1.4.4): run only when `textSize` ≥ `accessibility-medium` active; text frame exceeds parent / truncated (`…`).
- `packages/e2e/src/a11y/audit.ts`: `runAudit(snapshot, opts: { rules?, ignore?: { rule, id? }[], minSeverity? })`.
- Config: `warden.config.ts` suite key `a11y: { ignore, minSeverity }` (core config schema + `define-config.ts`).
- Tests first: one fixture per rule (pass + fail), ignore handling, config parse.

### A11Y-4 — ✨ feat(e2e): native audits (XCUITest + ATF)
Depends: A11Y-0 (4, 9), A11Y-3 types.
- iOS: PHY runner `RunnerCore` new command `audit { bundleId, types[] }` → `performAccessibilityAudit` with a handler that collects every issue and returns `true` (no XCTest failure; `continueAfterFailure = true` per PHY-0). Map `auditType` → `A11yIssue` (`source: "xcuitest"`, `rule: "native"`, keep `auditType` in message, element → identifier/frame for matching). Works on sim and physical. Sim needs the runner build (reuse PHY build cache); if absent, `skipped` with reason, never failing the audit.
- Android: ATF checks inside uiad (`audit` op) if A11Y-0.9 ✅ → `source: "atf"`. Else `skipped`.
- `audit.ts` merges sources, de-dupes warden vs native findings on the same element+WCAG ref.
- Tests: Swift unit test for issue encoding (`RunnerCoreTests`), TS mapping tests with recorded JSON fixtures from the spike, `native` signoff check runs (packages/e2e/native changed).

### A11Y-5 — ✨ feat(e2e): spec API + matchers
Depends: A11Y-2, A11Y-3 (A11Y-4/7/8 plug in when merged).
- `device.ts` / `traced-device.ts` / remote protocol + client:
  - `device.a11yAudit(opts?) → A11yAuditResult`
  - `device.screenReader.order() → Announcement[]`, `.focused()`, `.next()`, `.prev()`, `.activate()`, `.spoken({ since? })` (last four: real TalkBack only, else `E_UNSUPPORTED` with hint)
  - `device.announcements({ since? }) → { text, at, source }[]`
  - `device.a11y({ screenReader: true, reduceMotion, boldText, … })` extends the existing op.
- Matchers in `expect/matchers.ts` (auto-wait like the rest): `toHaveAccessibleName(str|re)`, `toHaveRole(role)`, `toHaveHint(str|re)`, `toAnnounce(str|re)` (element's computed announcement), `toBeA11yFocused()`, `toPassA11yAudit(opts?)` (on `device`/screen), `toHaveAnnounced(str|re)` (on `device`, polls announcements).
- Failure output: rendered issue table + `screen-at-failure.txt` with `--a11y` columns.
- Tests first: matcher unit tests on fake driver (`driver.testing.ts`), remote protocol round-trip.

### A11Y-6 — ✨ feat(e2e): remaining display settings + fake screen-reader flag
Depends: A11Y-0 (1, 2, 11).
- iOS (`ios-settings.ts`): `reduceMotion`, `boldText`, `reduceTransparency`, `buttonShapes`, `differentiateWithoutColor` via `simctl spawn <udid> defaults write com.apple.Accessibility <Key> -bool …` + the notify/relaunch the spike found (report `appliesOnLaunch` in `notes` if relaunch needed). Stop reporting them as `skipped`.
- iOS `screenReader: true` → ios-inject state flag `voiceOver: true` (inject loaded when this condition is active; extend the load trigger in `driver/ios/inject.ts:16,79-91`), interposed `UIAccessibilityIsVoiceOverRunning`, posts status-change notification on flip. State `{ mode: "simulated", engine: "voiceover" }`.
- Android: `highContrastText` (`secure high_text_contrast_enabled`), `colorInversion` (`secure accessibility_display_inversion_enabled`), `reduceMotion` per A11Y-0.11 (coordinate with the driver's animation scales: record previous, restore on undo).
- Undo (`packages/core/src/conditions/undo.ts:45-49,73-77`): reset every new key; iOS `defaults delete` the keys warden wrote (never ones it didn't).
- Tests first: argv builders, undo argv on release (temp `WARDEN_HOME`, injected exec), `appliedA11y` filtering.

### A11Y-7 — ✨ feat(e2e): real TalkBack mode (Android)
Depends: A11Y-0 (5–8), A11Y-1, A11Y-6 condition plumbing.
- `android-settings.ts` `screenReader: true`: check `pm path com.google.android.marvin.talkback` → missing = `E_UNSUPPORTED` with fix text (use a Play Store AVD); record previous `enabled_accessibility_services` + `accessibility_enabled` in `A11yCondition.previous`; append TalkBack component (keep other services); skip first-run tutorial (spike method); enable verbose speech log (spike prefs). Verify with `dumpsys accessibility` before returning (no sleep-and-hope).
- Driver mode switch `screenReaderActive`: `press` → uiad `ACTION_CLICK` on the resolved node (fallback: a11y focus + double-tap at node centre); `scroll` → `ACTION_SCROLL_FORWARD/BACKWARD` on the scrollable ancestor; `fill` unchanged (set-text); raw `tap x y` documented as "moves TalkBack focus only".
- `screenReader.next/prev` → uiad moves a11y focus to the next/prev node in TalkBack traversal (A11Y-0.7 method); `activate` → `ACTION_CLICK` on focused; `focused` → `findFocus(FOCUS_ACCESSIBILITY)`.
- Speech: `packages/e2e/src/a11y/talkback-log.ts` parses logcat (spike regex) into `spoken` lines with timestamps; logcat reader scoped to the lease's serial, stopped on release.
- Undo: restore previous services string exactly; `accessibility_enabled` back to previous.
- Never on a foreign device; physical Android allowed only with `--physical` lease and restore guaranteed.
- Tests first: settings argv + previous-value restore, logcat parser fixtures, driver press path selection on fake driver.

### A11Y-8 — ✨ feat(e2e): announcements + live regions
Depends: A11Y-0 (2, 10).
- Android: uiad event listener buffers `TYPE_ANNOUNCEMENT` and `TYPE_WINDOW_CONTENT_CHANGED` with `CONTENT_CHANGE_TYPE_TEXT` on live-region nodes; `announcements` op drains since a cursor. No TalkBack needed.
- iOS sim: ios-inject interposes `UIAccessibilityPostNotification` → records `.announcement` text, `.screenChanged`, `.layoutChanged` to the inject output file; host reads via the existing state/ack channel (new `events` file, append-only, cursor by byte offset).
- Device-level `announcements()` merges both; `toHaveAnnounced` polls.
- Tests: Java unit (event → JSON), inject output parser, matcher polling with fake clock.

### A11Y-9 — ✨ feat(cli): `warden ui a11y …` verbs
Depends: A11Y-5 (+ whichever W2/W3 phases merged).
- `apps/cli/src/agent-ui/settings-register.ts` / `settings.ts`: extend `a11y set` with `--screen-reader|--no-screen-reader`, `--reduce-transparency`, `--button-shapes`, `--differentiate-without-color`, `--high-contrast-text`, `--color-inversion`.
- New: `warden ui a11y audit [--rule <id>…] [--ignore <rule[:id]>…] [--min-severity error|warning] [--json]`, `warden ui a11y order [--json]` (simulated reading order), `warden ui a11y speak <locator>`, `warden ui a11y announcements [--since <cursor>]`, `warden ui a11y focus next|prev|activate|status` (TalkBack), `warden ui snapshot -i --a11y`.
- Read-only subcommands added to `agent-ui/run.ts:11-21` list.
- Exit codes: audit with errors → non-zero (document), `E_UNSUPPORTED` as today.
- Tests: command parse + output snapshots; `skill-coverage.test.ts` green.

### A11Y-10 — ✨ feat(example): a11y showcase + suite
Depends: A11Y-5, A11Y-9.
- New route `apps/example/src/app/a11y.tsx` (reach from welcome like `conditions.tsx`), add to spec→screen map (`warden.config.ts:54-71`): labelled controls, heading, switch, adjustable slider, image with/without label, live-region counter, `announceForAccessibility` button, custom actions on a row, a small 20pt target behind a `?bad=1` deep-link param so the audit has known failures.
- Fix real a11y gaps found in existing screens (todos, settings) rather than ignoring them.
- `apps/example/e2e/a11y.e2e.ts`: reading order golden, `toAnnounce`, `toPassA11yAudit` (good mode), expected issues (bad mode), `toHaveAnnounced`, text-size `accessibility-extra-large` + `text-clipped`, `screenReader: true` → RN `isScreenReaderEnabled` reflected in UI, Android TalkBack: `next/next/activate` toggles the switch, `spoken()` contains its name.
- Suite `a11y` in `warden.config.ts`; run `warden e2e a11y` on iOS + Android, evidence attached to the PR.

### A11Y-11 — 📝 docs: skill, docs site, changeset
Depends: all shipped phases.
- `skills/warden/references/a11y.md` (new reference: settings, audit rules table with WCAG refs, speech model caveat "simulated", TalkBack mode rules, iOS limits). Router line in SKILL.md; `specs.md` matchers + `device.screenReader`; `ui.md` verbs; `troubleshooting.md` append (never renumber): TalkBack missing, TalkBack tutorial blocking, inject not loaded, XCUITest runner missing.
- `apps/docs/content/docs/accessibility.mdx` + nav.
- `.changeset/screen-reader-a11y.md`: `"@delacour/warden": minor`.
- Verify: `cd apps/cli && bun test src/skill-coverage.test.ts src/skill.test.ts`; `bun changeset status --since=origin/develop`.

### A11Y-12 — (deferred) physical iPhone VoiceOver
VoiceOver can't be toggled by API on device; options are the Accessibility Shortcut (user triple-click) + PHY runner reading focus. Revisit after A11Y-4 runs audits on physical iPhones.

## Ship
`bun run typecheck && bun run check && bun run test`, then `gh pr create` into `develop`, then `bun run signoff` (`native` check runs because native changed; dispatch CI if Xcode is unavailable here). Done = `signoff` SUCCESS on head.

## Best-practice notes
- Target WCAG 2.2 AA (4.1.2, 1.1.1, 2.5.8, 2.5.3, 1.4.4, 2.4.3, 4.1.3) + Apple HIG 44pt / Material 48dp as warnings.
- Automated checks catch structural issues only; keep a manual VoiceOver-on-device pass in the release checklist (docs page says so).
- Simulated speech is an approximation: name it "simulated" in API, output and docs; never claim it equals VoiceOver.
