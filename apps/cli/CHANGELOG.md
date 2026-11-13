# @delacour/warden

## 0.17.0

### Minor Changes

- [#264](https://github.com/delacournz/warden/pull/264) [`97a9732`](https://github.com/delacournz/warden/commit/97a9732a25b70c2298b97cfa2a8fb74592bc7b7f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New `warden e2e --build-only`: builds (or finds) the app the run would install into the cache, with the same suite, specs, kind, variant and bundle env, then stops before any device or spec. Exit 1 when the build fails; `--json` prints `{suite, platform, app}` (`app: null` when the suite installs no app). Not with `--dry-run`
  - The `delacournz/warden/.github/actions/e2e` action builds the app with it in a step of its own before the suite, so `suite-timeout-minutes` times the specs only: a cold native build no longer runs the suite out of time. A failed build skips the suite. The `job timing` line adds an `app build` span

- [#269](https://github.com/delacournz/warden/pull/269) [`f7c0836`](https://github.com/delacournz/warden/commit/f7c0836f30c7be7da88c00175d8561684ed49043) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New `@delacour/warden/expo-build-cache`: set `buildCacheProvider: { plugin: "@delacour/warden/expo-build-cache" }` in the app config and plain `expo run:ios` (Debug, simulator) reuses the dev build in warden's cache instead of running `xcodebuild`, and files its own build there after a miss. Projects with a variant, a custom build command or `native+js` fingerprinting, Release runs, device runs and Android are left to Expo
  - New `warden builds path <ios|android> [--kind dev] [--hash <fp>] [--json]` prints where the cached dev build is without building or downloading anything; exit 2 when nothing is cached
  - `warden builds import <App.app> --kind dev [--hash <fp>[:dev]]` files a Debug simulator `.app` as the project's dev build, the one `warden dev` and `warden app ensure --kind dev` share

- [#262](https://github.com/delacournz/warden/pull/262) [`c38e09a`](https://github.com/delacournz/warden/commit/c38e09a2e10201ccb865afe0703a78cf305a9699) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden init --platform ios|android` writes the e2e suite's platform (default `ios`); an Android suite needs an Android package, so pass `--bundle-id` when `app.json` has none. A bad value is an error.
  - `warden init` prints the `@delacour/warden-e2e` install for the project's package manager (`bun add -d`, `pnpm add -D`, `yarn add -D` or `npm install -D`, from the lockfile; bun without one).
  - `warden init` ends with the next steps in order, and the starter spec explains `launch: "none"` and `systemAlerts: "dismiss"`.

- [#266](https://github.com/delacournz/warden/pull/266) [`6845940`](https://github.com/delacournz/warden/commit/6845940466767f7f2e9e1a95391ecc15bbf5a77f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS Simulators driven by warden (`warden e2e`, `warden ui`) have autocorrect, predictive text and spell check turned off, so text a spec types reads back as typed: a fresh simulator could autocorrect `Buy` + ` milk` to `But milk`. Autocapitalization is left on.

- [#267](https://github.com/delacournz/warden/pull/267) [`d49016b`](https://github.com/delacournz/warden/commit/d49016bd8b7f276944a9b3fe70dae87bbe54f660) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `--json` output now carries `schemaVersion` on `warden claim`, `warden release`, `warden dev`, `warden app ensure`, `warden e2e` (the report, every `--json-lines` event and `e2e-report.json`), the `warden ui` envelope and every failure envelope. It goes up only for a breaking change.
  - JSON Schemas for those outputs are published at `https://warden.co.nz/schemas/<schema>/<version>.json`, with `index.json` listing each one, the command that prints it and where. `warden ui snapshot`, `press`, `tap`, `fill`, `wait`, `is`, `get`, `open` and `close` each have one for their `result`.

- [#268](https://github.com/delacournz/warden/pull/268) [`e47d14f`](https://github.com/delacournz/warden/commit/e47d14f82fb209615a67f8090b63f85217384b1e) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New `warden pods install [--project-directory <dir>] [--no-cache] [-- <pod args>]`: `pod install` through a machine-wide cache. The same pods anywhere on the Mac restore into a new worktree by APFS clone in seconds with almost no extra disk (Expo: prebuild is skipped too). `--json` prints a `warden.pods.install` document.
  - New `warden pods ls`, `warden pods rm <key…>` and `warden pods prune [--max-size 10G] [--older-than 30d]` manage the cache.
  - warden's own iOS builds restore cached pods; `WARDEN_PODS_CACHE=0` opts out.
  - `warden gc` prunes pods cache entries unused for 30 days.

- [#271](https://github.com/delacournz/warden/pull/271) [`5e5eda6`](https://github.com/delacournz/warden/commit/5e5eda6fcdada0d2815f731fe0ee7cdf62b5d32d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui snapshot -i` folds the iOS on-screen keyboard into one line, `@eN [keyboard] return="go" visible (x,y w×h) N keys (--keys)`, instead of ~40 key lines. The ref is the return key's, so `press @eN` presses go/next/return. In `--json` it is one element with `role: "keyboard"`, the return key's `name` and a new optional `keys` count.
  - New `--keys` flag on `warden ui snapshot`: with `-i`, lists every key again. A snapshot without `-i` is unchanged.
  - `snapshot -i` and spec failure excerpts leave out 0×0 elements that are neither hittable nor carry a testID (the keyboard's `Padding-*` buttons).

### Patch Changes

- [#273](https://github.com/delacournz/warden/pull/273) [`b666166`](https://github.com/delacournz/warden/commit/b6661665de428f14541d52678aca913ec6007378) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Android: an edit field holding exactly its hint's text now reads as filled, not empty: `warden ui snapshot` prints its `value=`, `get … value` and the spec matchers return the text. The on-device server now says whether a field shows its hint, so an empty field and a filled one are told apart exactly; with no answer (the `uiautomator dump` fallback, an older server) the field still reads as empty when its text equals the hint.

- [#266](https://github.com/delacournz/warden/pull/266) [`6845940`](https://github.com/delacournz/warden/commit/6845940466767f7f2e9e1a95391ecc15bbf5a77f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `device.perf` works in specs run by an installed `warden` binary: the `warden perf` it starts no longer runs as bun and fails with `error: Script not found "perf"`.

- [#260](https://github.com/delacournz/warden/pull/260) [`bb3aab6`](https://github.com/delacournz/warden/commit/bb3aab68ffc5deaddf8787405d3fe01c55f0faf9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - The e2e action runs `warden doctor` after it installs ccache, so a native build cache miss no longer warns that ccache is not on PATH.

- [#266](https://github.com/delacournz/warden/pull/266) [`6845940`](https://github.com/delacournz/warden/commit/6845940466767f7f2e9e1a95391ecc15bbf5a77f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS specs find warden's injected library in the helper directory `warden doctor --fetch-helper` fills (`$WARDEN_HOME/simd/<version>`) when warden runs from source, so `device.keyboard`, network and clock conditions and the screen-reader reads work there instead of silently doing nothing.

- [#274](https://github.com/delacournz/warden/pull/274) [`755869e`](https://github.com/delacournz/warden/commit/755869e0fc0774f90bae63eefa1442bc6ca2e055) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `warden ui fill` and the spec `fill` type the first attempt at quick key pacing when the field is read back afterwards, and retype at the normal pacing if it does not match: on the example app a 15-character email fills in ~0.6 s instead of ~0.85 s and 60 characters in ~1.3 s instead of ~2.5 s. Secure fields, `--secure`, `--no-verify`, `type` and `clear` keep the normal pacing. Setting any `WARDEN_SIMD_PACE_MS` / `WARDEN_SIMD_HOLD_MS` / `WARDEN_SIMD_REPEAT_GAP_MS` / `WARDEN_SIMD_LEAD_MS` turns the quick attempt off.
  - iOS: a secure field that holds text is emptied with select-all and one Backspace, then checked to show no bullets (any left are backspaced one by one), instead of one Backspace request per bullet: re-filling a 9-character password takes ~0.8 s instead of ~1.7 s.

- [#250](https://github.com/delacournz/warden/pull/250) [`dcc7a0e`](https://github.com/delacournz/warden/commit/dcc7a0e8ead75b6d189aa325846193b73fdbe94c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden mcp` exits when its client closes stdin or dies: it also stops on SIGTERM/SIGINT/SIGHUP and a broken stdout, and checks its parent every 2 s, so a killed client no longer leaves an orphaned `warden mcp` behind

- [#265](https://github.com/delacournz/warden/pull/265) [`921cbfc`](https://github.com/delacournz/warden/commit/921cbfcb0a24ae7746057400c197ee261a59085e) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: a tap, swipe, drag, pinch or gesture sent in normalized (`norm`) coordinates now scales by the way the app's interface is drawn, not the way the device is turned, so it lands on a portrait-locked app on a rotated simulator and on a landscape-only app on an upright one. Point coordinates (`warden ui press`, refs, spec taps) were already right in every orientation and are unchanged.
  - iOS: a snapshot of an app turned to landscape reports the landscape screen size, so elements on its right half are `hittable` and visible to specs (they were treated as off screen, and `tap` waited for them until it timed out).
  - iOS: a read taken while the simulator is still rotating (`Simulator display changed during the operation`) is retryable, so `expect` and `tap` look again instead of failing at once.
  - iOS: `warden ui screen rotate` and `device.orientation(set)` return once the rotation animation is over (about 0.7 s), so a tap right after them is no longer dropped.
  - iOS: a hit-test on a landscape app measures the element against the landscape screen, so elements on the right half count as on screen.
  - The warden skill says that after `screen rotate`, snapshot frames, screenshots and `press x y` are in the app's interface space and that a rotation returns once it has finished.

- [#266](https://github.com/delacournz/warden/pull/266) [`6845940`](https://github.com/delacournz/warden/commit/6845940466767f7f2e9e1a95391ecc15bbf5a77f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The npm `warden` command works after a CI cache restores it as a copy instead of a symlink (EAS Workflows' `eas/save_cache` stores files, not links): it finds `@delacour/warden-<platform>` under `<prefix>/lib/node_modules/@delacour/warden` instead of failing with `@delacour/warden-<platform> is not installed`.

- [#266](https://github.com/delacournz/warden/pull/266) [`6845940`](https://github.com/delacournz/warden/commit/6845940466767f7f2e9e1a95391ecc15bbf5a77f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The warden skill points agents at the new CI docs: `/docs/e2e/ci/github-actions` for the GitHub Actions composite action and `/docs/e2e/ci/eas-workflows` for running `warden e2e` on Expo Workflows with a reused EAS build.

- [#270](https://github.com/delacournz/warden/pull/270) [`1cd9d23`](https://github.com/delacournz/warden/commit/1cd9d231df502f0c4c31f8caf7b24e7f999b2b9d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The `warden` skill teaches agents to drive `warden ui` in fewer turns: target `id=<testID>` instead of `@eN` in chains, batch known steps in one shell call with `&&`, `wait` on the destination instead of snapshotting after every step, and snapshot once at the end. It now says that a recent `@eN` taps the frame its snapshot stored (so it misses after a `fill` opens the keyboard), that a newer snapshot renumbers refs, and that `warden ui get` / `is` take a selector plus a property or state

- [#273](https://github.com/delacournz/warden/pull/273) [`b666166`](https://github.com/delacournz/warden/commit/b6661665de428f14541d52678aca913ec6007378) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui snapshot` no longer reports an empty text field's placeholder as its value: iOS and Android show the placeholder (iOS) or hint (Android) as an empty field's value, which read as filled. Text inputs now print `placeholder="…"` (and `placeholder` in `--json`), and `value=` only when the field holds something else.
  - `warden ui get … value`, `wait text`, `text=` / `value=` selectors and the spec matchers `toHaveValue` / `toHaveText` read a field showing its placeholder as empty. A field holding exactly its placeholder's text reads the same (the platforms report it identically); `fill` with that text still confirms.
  - iOS: React Native inputs now carry their placeholder on the default accessibility reader too (it left them out), so `getByPlaceholder` finds them. Each field costs one extra lookup (~10 ms) the first time it is seen.

- [#272](https://github.com/delacournz/warden/pull/272) [`8b3c021`](https://github.com/delacournz/warden/commit/8b3c02182ea6c6765b25dd462582928d38dc035b) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui press` / `fill` / `gesture` on an `@eN` taken before another input (a fill that brought the keyboard up, a press, a scroll) re-check the ref first and act on its current frame, instead of tapping where it used to be (which could type a key on the keyboard). On iOS an unmoved ref costs one hit-test (~10 ms); a ref that is gone, now matches more or fewer elements, or sits under the keyboard fails with `stale_ref` (exit 4) and nothing is tapped.

- [#251](https://github.com/delacournz/warden/pull/251) [`2a6631b`](https://github.com/delacournz/warden/commit/2a6631bb33bd3669ce850457092101a5a6d7b054) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS runner builds (`warden ui` on an iPhone, the Simulator runner behind `audit`) and local iOS device app builds write an `.xcresult` bundle; `build_failed` / `local build failed` now name the first 5 compiler or signing errors with file:line, and the bundle's path.
  - `E_XCODEBUILD_EXITED` from the iPhone runner and `E_HELPER_CRASHED` from the Simulator runner carry the test failure message (with file:line) from the bundle instead of only the last log lines, plus the bundle path (`detail.resultBundle` on `E_HELPER_CRASHED`).
  - Only the last 3 bundles per runner cache and device are kept; an unreadable bundle falls back to the log tail as before.
- Updated dependencies []:
  - @delacour/warden-e2e@0.17.0

## 0.16.0

### Minor Changes

- [#246](https://github.com/delacournz/warden/pull/246) [`6ce64a2`](https://github.com/delacournz/warden/commit/6ce64a206bf1bc8110ffdf26b7cb7c456c221f87) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `@delacour/warden-e2e` no longer carries the Android Accessibility Test Framework jar inline: the first Android `device.a11yAudit()` / `warden ui a11y audit` downloads it (~180 KB, sha256-checked) from the version's GitHub release and caches it in `~/.warden/atf/`. New releases go live on npm in minutes instead of waiting ~16 minutes in npm's automated review.
  - New `WARDEN_ATF_JAR=<path>` points the audit at a local copy of the jar for hosts that cannot reach GitHub. Without it, an unreachable download skips the ATF engine with a warning; warden's own audit rules still run.

- [#249](https://github.com/delacournz/warden/pull/249) [`0df88e1`](https://github.com/delacournz/warden/commit/0df88e1e71099aaa34a3323595b9c1cc1c997c17) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Specs: `device.os` (`"ios"` | `"android"`), `device.isIOS` and `device.isAndroid` name the platform under test, like React Native's `Platform.OS`, so a step only one platform needs can sit behind an `if` (and helpers that only get `device` can branch too)

- [#249](https://github.com/delacournz/warden/pull/249) [`0df88e1`](https://github.com/delacournz/warden/commit/0df88e1e71099aaa34a3323595b9c1cc1c997c17) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Specs: `device.select({ ios, android })` returns the value for the platform under test, like React Native's `Platform.select` (give both platforms or a `default`), so a label or testID that differs per platform stays one line: `screen.getByText(device.select({ ios: "Done", android: "OK" }))`

- [#245](https://github.com/delacournz/warden/pull/245) [`489e700`](https://github.com/delacournz/warden/commit/489e700625cd6ee509ac0bb0a6be7896e56f2a31) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e`, `warden repack` and `app ensure --kind simulator` no longer wait for a fresh simulator base build before bundling: iOS runs the JS bundle alongside the native build, then Hermes-compiles and repacks once the base is ready
  - Android: a simulator base built in the same run already embeds the worktree's JS, so its apk becomes the repack with no second bundle or re-sign; `warden repack --json` and `--json` kind facts report `fromBase: true`, and the log reads `simulator repack <jsKey> built from the base build's bundle`

- [#219](https://github.com/delacournz/warden/pull/219) [`6cafe3d`](https://github.com/delacournz/warden/commit/6cafe3d32b0df0e56ec9da40e84b46bdee473310) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New `describe.serial(title, body)` (also `describe(title, { serial: true }, body)`, which used to do nothing): the group's tests share one app launch, opened once before the group's `beforeAll`, and once a test fails the rest are recorded as `skipped` with the new error code `SKIPPED`. `retry` on a test inside such a group is `INVALID_ARGUMENT`
  - In a `describe.serial` group the suite's `conditions` baseline is applied once, before the group's launch and `beforeAll`, instead of before every test: re-applied to the running app it restarted a live camera feed, which then stopped decoding QR codes
  - `beforeAll` / `afterAll` now run with the scope's timeout, report their steps, and on failure write `failure.png`, `screen-at-failure.txt` and a `failed` or `timed-out` line in `results.jsonl` titled with the describe titles and the hook name. Before, a failed `beforeAll` left no result and no evidence for its group
  - Fixtures a `beforeAll` / `afterAll` keeps past its end now fail with `SESSION` inside a test instead of acting outside any test
  - A `describe` body that takes arguments or is `async` is now `INVALID_ARGUMENT`: describe bodies run at collection and get no fixtures

### Patch Changes

- [#258](https://github.com/delacournz/warden/pull/258) [`dc45d6d`](https://github.com/delacournz/warden/commit/dc45d6d7350af8714404c27d521e70b5e036216d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The npm description and the `warden` skill now introduce warden as an AI agent toolkit: every agent gets its own simulator to drive, debug, profile and E2E test the app.

- [#219](https://github.com/delacournz/warden/pull/219) [`6cafe3d`](https://github.com/delacournz/warden/commit/6cafe3d32b0df0e56ec9da40e84b46bdee473310) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - An iOS read the bridge answered by the app's pid (when the frontmost app cannot be resolved) is no longer treated as a degraded read: absence checks on it are conclusive again, and `READ_DEGRADED` no longer says it "fell back from axbridge to axbridge"

- [#257](https://github.com/delacournz/warden/pull/257) [`29dc6d4`](https://github.com/delacournz/warden/commit/29dc6d420c786dff3325f78d640b1b6a9b0d0c81) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS local builds (`warden builds`, `warden e2e`, `warden dev`) now actually use ccache: warden exports `CCACHE_BINARY` (the `ccache` on `PATH`, or your own `CCACHE_BINARY`), which React Native's compiler wrapper needs. Before, every compile skipped ccache and `~/.warden/ccache` stayed empty.
  - `warden ci cache --json` prints `ccache: null` when the project sets `build.cache: false`, so the e2e action no longer installs, restores or saves a compiler cache the build never uses.

- [#219](https://github.com/delacournz/warden/pull/219) [`6cafe3d`](https://github.com/delacournz/warden/commit/6cafe3d32b0df0e56ec9da40e84b46bdee473310) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `locator.clear()` no longer fails with `ACTION_FAILED` on an iOS React Native text field that has a placeholder: an emptied field reads back as its placeholder there, and `clear()` now counts a value that deleting could not have left (not made of the cleared text's characters, in order) as empty, and a field that was already empty is told apart from one holding its placeholder's text by typing one key (deleted again)

- [#219](https://github.com/delacournz/warden/pull/219) [`6cafe3d`](https://github.com/delacournz/warden/commit/6cafe3d32b0df0e56ec9da40e84b46bdee473310) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `tap()`, `longPress()` and `scrollTo()` no longer press a control drawn over the target: a sticky footer (with its padded bar), a tab bar or a floating button later in the tree, or the header over a row scrolled past the top of its list. The press goes to the part of the target nothing covers, a wholly covered target in a scroll view is dragged clear first, and one that cannot be fails `NOT_ACTIONABLE` naming the cover.
  - `scrollTo()` keeps scrolling until the target is clear of covers, dragging it just past a footer or header instead of a whole page.
  - `tap({ until })` right after another input waits for the screen to settle before aiming, so it no longer taps where a sliding screen had the element.

- [#253](https://github.com/delacournz/warden/pull/253) [`6915044`](https://github.com/delacournz/warden/commit/6915044f231cc3d98fcebd232ac3456b6854e580) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden builds import --kind simulator-base` no longer warns about a missing `application-identifier` on an ad-hoc signed simulator build (`CODE_SIGN_IDENTITY=-`). Such a build signs with no entitlements and links them into the executable's `__TEXT,__entitlements` section, which is what the simulator reads; the check now reads that section too (`otool`), so `applicationIdentifier` in `--json` is `true` for it.

- [#219](https://github.com/delacournz/warden/pull/219) [`6cafe3d`](https://github.com/delacournz/warden/commit/6cafe3d32b0df0e56ec9da40e84b46bdee473310) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Tests skipped when collected (`test.skip`, `test.skipIf(true)`, `platforms` that leave out the device's platform, `requires` the device lacks) now get a `skipped` line in `results.jsonl` with code `SKIPPED` and the reason, so `warden e2e` counts them in its skipped total instead of reporting `0 skipped`

- [#219](https://github.com/delacournz/warden/pull/219) [`6cafe3d`](https://github.com/delacournz/warden/commit/6cafe3d32b0df0e56ec9da40e84b46bdee473310) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - A `describe` (or spec file) whose tests are all skipped when collected no longer runs its `beforeAll` / `afterAll` hooks, and a `describe.serial` group in that state no longer opens the app

- [#219](https://github.com/delacournz/warden/pull/219) [`6cafe3d`](https://github.com/delacournz/warden/commit/6cafe3d32b0df0e56ec9da40e84b46bdee473310) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `tap({ until })` no longer takes elements that only moved (the screen a Back returns to, still sliding in) for a reaction to the tap: a tap dropped during the transition is now sent again instead of being waited out
- Updated dependencies []:
  - @delacour/warden-e2e@0.16.0

## 0.15.0

### Minor Changes

- [#237](https://github.com/delacournz/warden/pull/237) [`9cb3f98`](https://github.com/delacournz/warden/commit/9cb3f988cfe013585c95f9955bf9962d2d054603) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - A local native build nobody streams (`warden e2e`, `warden ui open`, CI) now says why it is building (`no cached ios build for <hash>: building it from source…`) and logs `still building ios (6m 0s): <last build line>` every minute, so a 15-20 minute cold build on CI no longer looks hung.
  - The whole output of a green native build is now kept in `~/.warden/logs/build-<platform>-<hash>.log` too, not only a failed one's.
  - `warden ci cache --json` adds a `ccache` group (`~/.warden/ccache`, keyed by the native fingerprint, with `restoreKeys` to fall back to the newest older cache on a miss).
  - The e2e GitHub action, on a native build cache miss: prints a `native build cache miss` notice, installs `ccache` and restores / saves the compiler cache (new `compiler-cache` input, default `true`), and prints each native build log in a collapsed group with ccache's stats.

- [#242](https://github.com/delacournz/warden/pull/242) [`fed7868`](https://github.com/delacournz/warden/commit/fed786805442dda2f58a7a22ea540550cf69f41d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` no longer shuts down the simulators / emulators it created after a passed gate when running under `CI` (or `GITHUB_ACTIONS=true`): the runner is thrown away, so the shutdown only cost time. A suite's explicit `shutdown: "always"` still shuts them down; locally the default is unchanged.

- [#235](https://github.com/delacournz/warden/pull/235) [`dc91440`](https://github.com/delacournz/warden/commit/dc91440b996c887346321ca6eadd332b750a7024) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `e2e.<suite>.golden` in `warden.config.ts`: `true` clones the suite's new iOS simulators from a golden image. It is off by default, so `warden e2e` now creates fresh simulators (`simctl create` + first boot) unless a suite opts in. `WARDEN_GOLDEN=0` still turns the golden off everywhere.
  - `warden ci cache --suite <name>`: the golden group is `null` when the suite (or the only suite) does not set `golden: true`, and the e2e action then skips restoring, building, saving and collecting a golden.

- [#233](https://github.com/delacournz/warden/pull/233) [`fea9583`](https://github.com/delacournz/warden/commit/fea958338ebca750f718c423abe2d7d2c2779c46) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden-simd` now recovers a simulator whose accessibility service wedged, for every reader (`warden e2e` with or without `--no-warm`, `warden ui`, `warden mcp`, a spec's own reads), not only the warm-up: when one read finds both accessibility readers silent, it checks the sim log for the wedge, confirms with a read that still times out, restarts backboardd once, ends its stale guests and reads on. Reads made meanwhile answer `E_TIMEOUT` with `reason: "ax_wedge_recovering"` (retryable).
  - New `WARDEN_SIMD_AX_WEDGE_RESTARTS` (default 1, `0` = never) bounds the restarts per helper; `health` reports `axWedge`, and stall reports carry `axWedge` / `axWedgeRestarts`.
  - A spec that failed across such a restart (its app was quit) runs once more.
  - The warm-up asks the helper to check instead of restarting backboardd itself; with an older helper it still does it itself.

- [#227](https://github.com/delacournz/warden/pull/227) [`bca6e96`](https://github.com/delacournz/warden/commit/bca6e96b2e92a7cd28450247cea4238c359af3fe) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: an accessibility bridge guest replaced after a stall now starts like a fresh one: its first read gets the cold deadline, its first stall no longer starts the 20 s cooldown, and the helper warms it in the background, going back to the bridge as soon as it answers.
  - New `WARDEN_SIMD_BRIDGE_MAX_RECYCLES` sets how many stalled guests one `warden-simd` helper may replace (default 3; `0` never replaces one; an invalid value keeps the default and logs a warning).

- [#237](https://github.com/delacournz/warden/pull/237) [`9cb3f98`](https://github.com/delacournz/warden/commit/9cb3f988cfe013585c95f9955bf9962d2d054603) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The on-screen keyboard now shows by default on every warden-leased iOS simulator and Android emulator, even while warden types with hardware key events. `hardware` mode hides it, as with a connected keyboard. Release puts the default back.
  - `warden ui keyboard software|hardware|toggle|status|reset` switches the mode live, so you can watch a bottom sheet or footer ride the keyboard. `status` prints the mode and whether a keyboard is showing. `warden ui status` lists a non-default mode.
  - Specs: `device.keyboard("software" | "hardware" | "toggle")`, `device.keyboardVisible()` and `expect(device).toHaveKeyboard()` / `.not.toHaveKeyboard()`. Suite config: `conditions: { keyboard: "hardware" }`.
  - iOS: a tap on a target under the keyboard scrolls it clear, or closes the keyboard without pressing Return, so a form is never submitted by accident. `device.hideKeyboard()` closes it the same way.
  - Android `hardware` mode turns the input methods off and `software` restores them exactly. Physical devices answer `E_UNSUPPORTED` to a mode change.

- [#220](https://github.com/delacournz/warden/pull/220) [`af78bcd`](https://github.com/delacournz/warden/commit/af78bcd71a1160176562b464a3f9e008f31a4f4c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui snapshot --settle` and every action's `--settle` wait for 500 ms of unchanged screen (was 250 ms), so a navigation push is never reported settled mid-transition.
  - `warden ui wait stable` defaults to 500 ms of quiet (was 250 ms); an explicit `wait stable <ms>` is unchanged.

### Patch Changes

- [#238](https://github.com/delacournz/warden/pull/238) [`7a66603`](https://github.com/delacournz/warden/commit/7a6660371b10309527d3d7f976ef181226cca316) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Fix `warden e2e` on Android failing with "a differently-signed copy ... is installed" on fresh emulators: an Android repack is now signed only with a keystore whose certificate equals the simulator base's signer.
  - When no available keystore matches the base's signer, the repack falls back to a full simulator build and names the signers it compared, instead of producing an APK the device rejects.
  - Build the Android base once and repacks keep its signer: warden saves the keystore Gradle signed the base with beside the cached APK (owner-only, never logged), so repacks no longer depend on a prebuilt `android/` dir.
  - The default Android build (`dev`, `release`, kind-less) runs `expo prebuild` when `android/` is missing and then Gradle alone, instead of `expo run:android`, which installed the APK on whichever emulator was booted and failed with `INSUFFICIENT_STORAGE` on a full one.

- [#224](https://github.com/delacournz/warden/pull/224) [`5e8d48a`](https://github.com/delacournz/warden/commit/5e8d48ae378e21368965042131e140f394081bff) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: a session's first read, while it retries a cold accessibility bridge (up to 60 s), now stops at the deadline of the `waitFor`, `expect` or `tap({ until })` it is part of instead of holding that wait for the whole 60 s
  - iOS: a bound `rebind` after `app.launch` no longer counts as proof that the bridge is up, so a first read that stalls right after a launch still waits for the bridge instead of failing at once
  - iOS: the e2e warm-up opens its driver with no cold budget of its own, so every `snapshot try N` in `logs/warm-<n>.log` is one read, 2 s then 5 s apart, instead of a nested 60 s loop

- [#223](https://github.com/delacournz/warden/pull/223) [`020eb67`](https://github.com/delacournz/warden/commit/020eb672f7efce6632253df3e034f98049ef2d6b) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `isVisible()`, `isHidden()` and `count()` on a degraded iOS read (the bridge fell back to host `ax`, or the read came back empty) now look again for at most 2 s before failing `READ_DEGRADED`, instead of the whole action timeout. A spec branching on them is no longer held for 30 s; a healthy read still answers at once, and none of them ever returns "absent" from a degraded read. `text()`, `read()`, `waitFor`, actions and matchers keep the action timeout.

- [#87](https://github.com/delacournz/warden/pull/87) [`c0d4c52`](https://github.com/delacournz/warden/commit/c0d4c52528122b47b0aa0769505569a0cfcb85d3) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` shows the simulator it leased: once the device is held it brings the sim's window to the front, launching Device Hub (Xcode 27) or Simulator.app (Xcode ≤ 26) when no viewer is running, instead of leaving the window behind other apps or never opening one. `--headless` skips it; a viewer that can't be opened is a warning, not a failure.
  - `warden dev` shuts the simulator it booted down when it ends (Metro exits, Ctrl-C, a kill), and closes its Device Hub / Simulator.app window, instead of leaving it running until `warden gc` with a window behind. A sim that was already booted when leased, or one given with `--udid` / `--lease`, is left on. `--no-shutdown` keeps dev's own sim booted.
  - `warden dev` and `warden run` treat the terminal going away (SIGHUP) like Ctrl-C: the child is stopped and the leases released.

- [#218](https://github.com/delacournz/warden/pull/218) [`f3afe71`](https://github.com/delacournz/warden/commit/f3afe7164942472892e91c58ad840aa7ac867572) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The e2e action always collects and uploads the `logs` artifact (native build logs), after a failed run too and whatever the `artifacts` input lists, even `none`. A failed run with `artifacts: all` now uploads `report,batches,logs,golden`.

- [#229](https://github.com/delacournz/warden/pull/229) [`d85afd9`](https://github.com/delacournz/warden/commit/d85afd9e45981dbe9cf77c1e20a258ce6fae01b8) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The e2e action no longer uploads the `golden` artifact after a green run whose golden was restored from the cache: the cache already holds it, and the GB upload was the slowest step of a warm run (~30 s). A failed run still uploads it, and `artifacts: golden` (or any list naming it) still collects it.

- [#243](https://github.com/delacournz/warden/pull/243) [`a5a10c9`](https://github.com/delacournz/warden/commit/a5a10c918feee56d57314edcbeba62bb8cacd6cb) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` / `warden batch`: each finished-test log line now shows the run's total so far next to the test's own time, e.g. `✓ settings › signs out (15.26s · total 41s)`; the total counts from when the first spec started.
  - `warden e2e` ends with a line splitting the run's wall time, `took 2m52s — setup 1m24s · tests 1m26s · teardown 2s`, and `e2e-report.json` records it as `timing` (`totalMs`, `setupMs`, `testsMs`, `teardownMs`).
  - The e2e GitHub Action prints `job timing: prep <p> (workflow steps <w> · action <a>) · warden e2e <s> · total <t>` after the suite. A new `github-token` input reads the job's start from the jobs API (`actions: read`); without that permission the line times the action alone.

- [#241](https://github.com/delacournz/warden/pull/241) [`71271c1`](https://github.com/delacournz/warden/commit/71271c15b3b10eadd57657308f2169968b9099d1) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The iOS helper `warden-simd` now links idb v1.7.8 (was v1.7.7); `warden doctor` reports `idb v1.7.8`.

- [#233](https://github.com/delacournz/warden/pull/233) [`fea9583`](https://github.com/delacournz/warden/commit/fea958338ebca750f718c423abe2d7d2c2779c46) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` / `warden batch` on iOS: a simulator whose accessibility service was found wedged and whose reads still time out at the end of the warm-up (recovery failed, or recovered or rebooted yet still not answering) no longer runs specs that can only time out. It is dropped before its first job, its specs go to the other devices, and it is quarantined for 24 hours with a `warm: ` reason so claims skip it; like health-probe quarantines it lifts on its own after that, since a later boot clears the wedge (`warden sim unquarantine <udid>` gives it back sooner). Only warden's own devices are quarantined.
  - When every device of a run is dropped this way, the run fails with `no device left to run N jobs` instead of passing on nothing.
  - `e2e-report.json` `warm[]` entries gain `dropped` and `quarantined`; `axRecovery` can read `rebooted`.

- [#225](https://github.com/delacournz/warden/pull/225) [`76244c0`](https://github.com/delacournz/warden/commit/76244c0ba17422557cbdc3cd96b5c2c6c8c0bdf3) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: a password field (`secureTextEntry`) reads as `securefield` when a read falls back to host `ax`, empty or filled, so `fill` on it no longer fails with "fill did not take" while the accessibility bridge is degraded.
  - `fill` on a field that only reads back as bullets confirms the bullet count against the typed length, and its failure message gives the length instead of the typed text.
  - On a degraded read, `getByTestId` on a component that wraps its text (a badge around a `Text`) answers `toHaveText` / `text()` from the text its children render instead of failing with "only in the React tree".

- [#230](https://github.com/delacournz/warden/pull/230) [`71f5de8`](https://github.com/delacournz/warden/commit/71f5de88490a3aa6b8a74113f39809f6eb1a0ebc) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `tap({ until })` no longer takes elements leaving the screen for a landed tap. Right after a navigation, the screen it left and a keyboard going down stay in the accessibility tree until the transition ends, and a tap sent then is dropped; their leaving made `tap` stop re-sending, return after the full window without `until` ever showing, and the next assertion fail with "element not found". A tap now counts as landed only when something new shows or the tapped element is gone; otherwise it is re-sent from 750 ms on.

- [#233](https://github.com/delacournz/warden/pull/233) [`fea9583`](https://github.com/delacournz/warden/commit/fea958338ebca750f718c423abe2d7d2c2779c46) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` iOS warm-up: a simulator whose accessibility service stays wedged after the backboardd restart (backboardd could not be restarted, or 3 snapshots in a row still time out on the fresh helper) is now rebooted once and reconnected, instead of running that device's specs cold. Only a simulator the run leased is rebooted, and only once its app install, setup and Metro launch are done; installed apps survive and a biometrics sim is enrolled again. The device's warm budget grows by 90 s when it reboots (the 120 s budget is unchanged otherwise). The warm-up log says `rebooting <udid>: …` then `rebooted; reconnecting`.
  - `e2e-report.json` `warm[].axRecovery` gains `{ outcome: "rebooted" }`, and a failure carries `stage` (`log`, `restart` or `reboot`).

- [#233](https://github.com/delacournz/warden/pull/233) [`fea9583`](https://github.com/delacournz/warden/commit/fea958338ebca750f718c423abe2d7d2c2779c46) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` / `warden batch` iOS warm-up: a freshly booted simulator whose accessibility service wedged on first use (every read timed out for the life of the boot, `did not answer within the query's 10.0s timeout`, warm-up `timed out after 120s`) is now detected from its log (`Could not auto-register for pid status change`) once a snapshot times out, and recovered: warden restarts backboardd once and reconnects a fresh helper, instead of running that device's specs cold until they fail. The warm-up log says `accessibility service wedged: restarted backboardd`.
  - `e2e-report.json` gains `warm[]`: per iOS device `{ worker, udid, ok, error?, axRecovery? }`, with `axRecovery` `{ outcome: "recovered" }` or `{ outcome: "failed", error }`.

- [#228](https://github.com/delacournz/warden/pull/228) [`fac34f7`](https://github.com/delacournz/warden/commit/fac34f7b5f0d60ee3fbfef9f2eadb174e982dbc2) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: a text input in a web view (Safari, a `WKWebView`) reads as `textbox` instead of `other`, and a `type=password` input as a secure `textbox`, empty, focused or filled, so `getByRole("textbox")`, `fill` and `warden ui fill role=textbox …` reach web form fields.
- Updated dependencies []:
  - @delacour/warden-e2e@0.15.0

## 0.14.0

### Minor Changes

- [#208](https://github.com/delacournz/warden/pull/208) [`a277f23`](https://github.com/delacournz/warden/commit/a277f23cfb91b85dcf4b5b60028397dc76841526) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: the first accessibility read after the helper starts, a guest is recycled or an app launches gets a 12 s bridge deadline instead of 4 s, and a stall on it no longer sends the next 20 s of reads to the host `ax` reader (which drops testIDs on static text); a second stall on the same cold guest still does
  - iOS: `warden-simd` warms its bridge in the background at start and after each launch, and a read that arrives meanwhile waits for that read instead of starting a second slow one
  - iOS: the driver waits 20 s for a read while the bridge is cold, so it no longer times out before the helper's own deadline
  - New `WARDEN_SIMD_BRIDGE_COLD_DEADLINE_MS` (default 12000) sets the cold deadline; the driver's cold-read timeout follows it

- [#212](https://github.com/delacournz/warden/pull/212) [`2c6c311`](https://github.com/delacournz/warden/commit/2c6c3112ef7ac33cfd18a5f59a04e19505a15202) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - On an iOS read that fell back from the bridge to host `ax`, a plain `getByTestId` whose React component has the same rect as a node on that read now resolves to that node: `text()`, `read()`, `allTexts()`, `toHaveText`, `toContainText`, `isVisible()`, `tap({ until })` and every action work as on a whole read, instead of failing `READ_DEGRADED` or `NOT_ACTIONABLE`.
  - A component host `ax` does not show at all (a plain View) answers `text()`, `read().text`, `allTexts()`, `toHaveText` and `toContainText` from the text it renders in the React tree.

### Patch Changes

- [#213](https://github.com/delacournz/warden/pull/213) [`01a1675`](https://github.com/delacournz/warden/commit/01a1675c15cc3ee50ad1836a278725844a4523f0) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: a read that leaves the in-sim accessibility bridge now says why in the run's evidence: `results.jsonl` gets a `bridge` field (`fallbacks`, plus the `first` and `last` such read with their reason or error code), the `driver.snapshot` span in `trace.jsonl` carries the stall (`stallStage` `connect` / `read` / `warm-up` / `cooldown`, `stallReadMs` against `stallDeadlineMs`, `stallCold`, `stallGuestAgeMs`, `stallCooldownMs`, `stallProbes`), and `screen-at-failure.txt` notes on its second line that the tree was read on `ax` after a stall

- [#207](https://github.com/delacournz/warden/pull/207) [`4f92d77`](https://github.com/delacournz/warden/commit/4f92d771ccde66585cc908099a8b0955ae48fc5c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - A spec read that fell back from the iOS bridge to host `ax` (or came back as an empty root) no longer counts a missing node as absent: `toBeHidden`, `.not.toBeVisible`, `toHaveCount(0)`, `waitFor({ state: "hidden" | "detached" })` and `isHidden()` keep polling instead of passing vacuously.
  - A plain `getByTestId` on such a read asks the React tree first when the app has devtools, and uses its presence and rect.
  - New error code `READ_DEGRADED` when nothing could confirm the locator before the timeout; the message names `fellBackFrom` and the read backend.

- [#211](https://github.com/delacournz/warden/pull/211) [`657fc3f`](https://github.com/delacournz/warden/commit/657fc3fcc83ca6539939bf18d4b1a9abab41f1fd) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: while the accessibility bridge is skipped after a stall, `warden-simd` checks it in the background with one cheap hit-test (1.5 s deadline, at most every 5 s) and goes back to it as soon as it answers, instead of after the full 20 s; a silent check keeps reads on `ax` so no read pays the 4 s bridge deadline again
  - iOS: a spec look that fell back to `ax` is returned at once instead of waiting up to 4 s on a second read through a silent bridge; the next look is back on `axbridge` once the check saw it answer
  - iOS: a read that asks for `backend: "axbridge"` during the skip waits only for the background check, then fails with `E_TIMEOUT` if the bridge is still silent
  - iOS: a cold guest whose background warm-up stalled is used again once the check sees it answer, instead of staying on `ax` until the next launch

- [#206](https://github.com/delacournz/warden/pull/206) [`b1121d2`](https://github.com/delacournz/warden/commit/b1121d2ddb129021a6988f4a22da66089e6d6a4b) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iPhone runner: an accessibility refusal during a `snapshot` (`kAXError…`, "Failed to get matching snapshot") no longer ends the runner; the read is retried once on the phone, then answered `E_AX_UNAVAILABLE` (retryable).
  - iPhone runner: an op that holds XCUITest past its timeout is answered `E_TIMEOUT` (`detail.stage: "deadline"`) instead of hanging the runner; until it returns, other ops answer `E_TIMEOUT` (`detail.stage: "busy"`) at once and `health` reports `state: "busy"`.
  - iPhone and simulator helpers: an element XCUITest cannot place (a null or infinite frame) is a zero-area, not hittable element, and a non-finite number is `null` on the wire, instead of failing the whole reply.

- [#214](https://github.com/delacournz/warden/pull/214) [`6c9f267`](https://github.com/delacournz/warden/commit/6c9f2673886b78d7a8f6c34dbcc1725412a898f0) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS: when the accessibility bridge stalls after it had already answered, `warden-simd` ends the stuck guest so the next read starts on a fresh one with the cold first-read deadline (at most 3 times per helper, then the background check alone brings it back)
  - iOS: the background check of a silent bridge backs off (every 5 s, doubling up to 30 s) and gets the cold deadline on a guest that is starting again, so a slow host can bring the bridge back instead of staying on `ax` for good; while it stays silent reads stay on `ax` without restarting the 20 s skip
  - iOS: bridge stall evidence (`results.jsonl` `bridge`, the `driver.snapshot` span's `stallRecycles` / `stallRecyclesExhausted`, `screen-at-failure.txt`) names how many stalled guests the helper had recycled and whether it had any left

- [#209](https://github.com/delacournz/warden/pull/209) [`fda83f9`](https://github.com/delacournz/warden/commit/fda83f9306e0a03d88602b3fd4deb0fa677d15e9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `device.settle()` fallbacks (`via: "snapshot"` and `via: "hash"`) now wait for at least 500 ms of unchanged screen, whatever `quietMs` asks: a navigation push shows both screens at their final frames for 300-460 ms, and the old 250 ms window could settle on that mixed tree.
- Updated dependencies []:
  - @delacour/warden-e2e@0.14.0

## 0.13.0

### Minor Changes

- [#202](https://github.com/delacournz/warden/pull/202) [`bd0848d`](https://github.com/delacournz/warden/commit/bd0848dcc5fc0947b155d6c80ce2e22ac8a1ff1b) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Host-spec limits are now off by default (changed default, hence minor): a claim boots the devices it asks for, with no RAM/CPU budget, no boot queue, no memory-pressure hold, and a `--max` that is not given no longer defaults to cores / 4 (the pool is uncapped). Opt back in with `WARDEN_CAPACITY=on` (`1` / `true` / `yes`); then the budget, queue and defaulted `--max` work as before. A `--max` you pass or set in config always holds. In CI (`CI=true` / `1` or `GITHUB_ACTIONS=true`) the RAM headroom defaults to 0 when limits are on, so a 7 GB runner no longer ends up with a 0 MB budget; `WARDEN_CAPACITY_HEADROOM_GB` still wins. `WARDEN_CAPACITY=off` is still accepted and is the default. `warden capacity` and `warden queue` still show the numbers and now say whether limits are enforced (`enforced` in `--json`; `capacity --json` keeps `enabled` as the same value). The `WARDEN_WARM=1` warm pool is no longer capped by the host budget unless limits are on.

- [#203](https://github.com/delacournz/warden/pull/203) [`e011293`](https://github.com/delacournz/warden/commit/e0112939e0be432962c9ff3c91adb3af3258a0d9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New `warden ci cache --json` prints the cache groups a CI job saves between runs (`builds`, `repack`, `golden`): each key, its paths, and for the golden the `warden golden import` / `export --allow-unsettled` commands to run around it. Flags: `--project`, `--prefix`, `--profile`, `--js-input`, `--golden-dir`
  - The e2e GitHub Action gains `cache: github|none` and a `cache-groups` output: `none` skips `actions/cache` and the golden export but still imports the golden, so any cache (a Namespace volume, another CI) can store the listed paths

- [#203](https://github.com/delacournz/warden/pull/203) [`e011293`](https://github.com/delacournz/warden/commit/e0112939e0be432962c9ff3c91adb3af3258a0d9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden golden export --allow-unsettled` exports a golden whose first boot never settled (`"unsettled": true` in `--json`), so a CI runner too small to settle one caches it instead of building it on every run. Without the flag the refusal now names it.
  - A simulator base, repack, dev or release build whose files a CI cache restored without `warden.db` is registered on first use (`"source": "restored"` in `warden builds --json`) instead of being rebuilt.
  - Builds are moved into the cache from a staging dir, so an interrupted copy never leaves a half-written build behind.

- [#215](https://github.com/delacournz/warden/pull/215) [`ee1398f`](https://github.com/delacournz/warden/commit/ee1398ff6d53959e2d38b28b2c1d848bb836205a) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The e2e GitHub Action collects what a run leaves behind into artifact groups, `report`, `batches`, `logs` (native build logs), `app` (a tarball of the builds the run used) and `golden` (a tarball of the golden simulator archive, for `warden golden import`), and uploads each as `<artifact-name>-<group>`. The report and batches, one `warden-e2e` artifact before, are now `warden-e2e-report` and `warden-e2e-batches`
  - New `artifacts` input: `all` (default: every group after a green run, `report,batches,golden` after a failed one), `none`, or a list of groups. The golden is exported only when it was built and is not in `~/warden-goldens` yet, never built to upload it
  - New `upload-artifacts` input: `false` collects without uploading. New outputs `artifact-groups` and `artifact-paths` (`{group: [path]}`) for uploading with your own steps

- [#199](https://github.com/delacournz/warden/pull/199) [`78878ac`](https://github.com/delacournz/warden/commit/78878ac3d752da069febd38b8dfa28bbc49d7b11) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - An `e2e.<suite>` can pin the iOS simulator runtime with `runtime` (`latest`, `iOS-26-5` or `26.5`), and `warden e2e --runtime <runtime>` overrides it. The run's devices and the golden they clone are the ones for that runtime, so `warden golden key --profile <p> --runtime <r>` names the archive the run uses. A runtime that is not installed fails the run before any claim, listing the installed runtimes, instead of falling back to another. `warden e2e`, `claim` and `batch` now also reuse an existing pool simulator when the runtime is given as a version (`26.5`, `27.0`), which only matched the `iOS-26-5` spelling before.

- [#200](https://github.com/delacournz/warden/pull/200) [`666de1c`](https://github.com/delacournz/warden/commit/666de1c0c76c64aaa0f50ddffb39efd9dff21f8d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `@delacour/warden-e2e` exports `run(command, options?)`: runs a shell string (`sh -c`) or an argv on the host from a spec and resolves `{ ok, exitCode, stdout, stderr, ms, json() }`, so a spec can seed a backend or call a script without importing from `bun`. Options `cwd`, `env`, `input`, `timeout` (default `60s`, then `TIMEOUT`) and `check` (default true).
  - New `E2eError` code `RUN_FAILED`: a `run` command exited non-zero or could not start.

### Patch Changes

- [#205](https://github.com/delacournz/warden/pull/205) [`d3b09fc`](https://github.com/delacournz/warden/commit/d3b09fc4edbb935b184570926b6ddf2a397a4fa5) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS reads that fell back to the host `ax` reader after an `axbridge` stall are read again on `axbridge`, so `getByTestId` on static text (which `ax` drops) still matches on slow CI runners; a guest that stays silent is retried at most every 5 s

- [#203](https://github.com/delacournz/warden/pull/203) [`e011293`](https://github.com/delacournz/warden/commit/e0112939e0be432962c9ff3c91adb3af3258a0d9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden builds import --kind simulator-base` warns when the `.app` has no `application-identifier` entitlement (an app built with `CODE_SIGNING_ALLOWED=NO`, whose Keychain calls fail with `errSecMissingEntitlement` / -34018 in the simulator) and says to build with `CODE_SIGN_IDENTITY=-`; `--json` gains `applicationIdentifier`.
  - The driver warm-up waits for `simctl bootstatus` before it starts a device's helper, so a golden clone that is still booting no longer answers the first snapshots with silence.
  - Driver warm-up of separate `devices` legs runs one leg after the other, as the devices of one leg already did, instead of every leg at once.
  - A host too small for one device (a 7 GB CI runner, where the 8 GB headroom leaves no budget) admits a lone claim while nothing else is booted, instead of queueing it for the whole `--wait`.

- [#216](https://github.com/delacournz/warden/pull/216) [`41b5f97`](https://github.com/delacournz/warden/commit/41b5f97f54b71d8d0d14dc68c8e5322ec78e9cd1) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden doctor --fetch-helper` downloads nothing when a `warden-simd` the driver picks first is already there (`WARDEN_SIMD`, `WARDEN_HELPER_DIR`, one next to the binary, a source build), and says where; `--json` reports `helperFetch.status` `present` or `fetched`.
  - Run from a checkout whose version has no release yet (a version-bump branch), `warden doctor --fetch-helper` takes the latest release's helper with a warning instead of failing on a missing `SHA256SUMS`.

- [#203](https://github.com/delacournz/warden/pull/203) [`e011293`](https://github.com/delacournz/warden/commit/e0112939e0be432962c9ff3c91adb3af3258a0d9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` / `warden batch` no longer trust `--serve-ready` when their own `--serve` died: a serve that exits before ready (a stale server held its port and answered the check) fails the run with `serve exited (N) before ready` and the serve log tail, a serve that exits mid-run kills the jobs and fails the run with `serve exited (N) during the run`, and a `--serve-ready` that already answers before serve starts warns `something is already listening on PORT`.

- [#201](https://github.com/delacournz/warden/pull/201) [`b0a943b`](https://github.com/delacournz/warden/commit/b0a943b2c0459752a6b955ce0643c05a2cc5498a) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - The `serve` of an e2e suite is documented as one process per run: started before the first spec and stopped after the last, shared by every device, leg, retry, `passes` repeat and shard, and never restarted. Specs must isolate their own state in it (for example a unique user per test). A test suite now holds `warden e2e` to this for `count`, `isolate`, `retry`, `passes`, `--devices`, a failing run and SIGINT.

- [#203](https://github.com/delacournz/warden/pull/203) [`e011293`](https://github.com/delacournz/warden/commit/e0112939e0be432962c9ff3c91adb3af3258a0d9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - `warden e2e`, `warden ui` and the specs find the `warden-simd` that `warden doctor --fetch-helper` staged under `$WARDEN_HOME/simd/<version>`. Before, a release binary with the helper fetched there (not next to it) failed every run with `E_HELPER_MISSING: warden-simd not found`.
  - A native fingerprint command that exits cleanly but prints nothing (seen on a loaded CI runner) is run once more; if it is still empty the error names the command, its directory and stderr, not `(empty)` alone.
  - Spec processes only get `WARDEN_HELPER_DIR` when `warden-simd` is in that directory. A directory without it (a release binary whose helper `doctor --fetch-helper` staged under `$WARDEN_HOME`, a checkout that never built it) made every spec fail with `E_HELPER_MISSING` instead of falling through to the staged copy.

- [#196](https://github.com/delacournz/warden/pull/196) [`d5e7d04`](https://github.com/delacournz/warden/commit/d5e7d04d2fbab57ba75a41ebb9d5ec84c6e8ae0a) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Driver warm-up retries a device's first snapshot with backoff (2 s after the first failure, then 5 s) until the 2 min per-device budget is spent, instead of giving up after one try, and warms devices one after the other instead of all at once. On a loaded host the in-sim bridge can stay silent longer than a single snapshot, which left devices cold and failed each device's first spec; warming several at once made that worse. Each failed try is logged to `warm-<n>.log`.
- Updated dependencies [[`094a1a9`](https://github.com/delacournz/warden/commit/094a1a9f1fac176aea617473ce0240526b4baa97), [`e011293`](https://github.com/delacournz/warden/commit/e0112939e0be432962c9ff3c91adb3af3258a0d9)]:
  - @delacour/warden-e2e@0.13.0

## 0.12.1

### Patch Changes

- [#193](https://github.com/delacournz/warden/pull/193) [`b0b992b`](https://github.com/delacournz/warden/commit/b0b992b802e68e5e6da6b14620cda760595d1a7a) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - A simulator repack is now valid only for the base it was cloned from. After `warden builds import --kind simulator-base` replaces the base under the same native fingerprint (a CI build with another signature or entitlements), `warden repack` and `warden e2e` repack instead of installing a repack of the old base. `warden repack --json` reports `reason: "base-changed"` when it does, and devices reinstall the new repack. A repack made by an older warden is rebuilt once (`reason: "base-unrecorded"`).
- Updated dependencies []:
  - @delacour/warden-e2e@0.12.1

## 0.12.0

### Minor Changes

- [#189](https://github.com/delacournz/warden/pull/189) [`87f4caf`](https://github.com/delacournz/warden/commit/87f4caf773c0f173cdb1a2f5ca7781d5cc64f2f8) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` prints a tail of the app's native log (at most 20 lines, errors and faults first, unresolved `<compose failure>` lines skipped) under a failed test; the full `native.log` stays in the evidence folder.
  - iOS `native.log` now includes info and debug lines, and warden makes sure the simulator keeps private values readable (`log config --mode private_data:on`) before the app runs. `WARDEN_NATIVE_LOG_PRIVATE=0` opts out.
  - A `native.log` whose messages mostly could not be resolved (`<compose failure>`) is noted in the trace as `native log: N of M messages unresolved`.

### Patch Changes

- [#192](https://github.com/delacournz/warden/pull/192) [`8813a2b`](https://github.com/delacournz/warden/commit/8813a2ba9850559ea1e09ea204bde422b3126ff8) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Building an iOS golden simulator writes `AutomationEnabled` into the shut-down golden's plist on the host instead of running `simctl spawn defaults write` in the booted sim. The in-sim write timed out on the iOS 27 runtime on CI, which failed `warden golden export` and made `warden claim` fall back from a clone to a fresh boot. Existing recipe-2 goldens are still reused.
- Updated dependencies []:
  - @delacour/warden-e2e@0.12.0

## 0.11.0

### Minor Changes

- [#185](https://github.com/delacournz/warden/pull/185) [`1451eae`](https://github.com/delacournz/warden/commit/1451eaed5f9cbf71bcfb6e9bbb45485b46c2ca42) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Anonymous usage telemetry, on by default. One `command` event per run: the command (`ui press`, `e2e`), the names (never the values) of the flags you typed, `--json`, `ios` or `android`, how many suites `e2e` was asked for, how it ended, how long it took, the exit code and the class name of an error. Never source, paths, suite or test names, bundle ids, UDIDs, URLs or error messages. The first run prints a notice to stderr (held back under `--quiet`); stdout and `--json` are never touched. `hook`, `heartbeat`, `version`, completion and background workers send nothing; `dev` and `mcp` report when they start.
  - `warden telemetry [status|enable|disable] [--json]` shows or switches it. `WARDEN_TELEMETRY_DISABLED=1`, `DELACOUR_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` turn it off and win over `enable`; `DELACOUR_TELEMETRY_DEBUG=1` prints the request to stderr instead of sending it. Dev and local builds never report. What is sent: [CLI reference](https://warden.co.nz/docs/reference/cli#telemetry).

### Patch Changes

- [#178](https://github.com/delacournz/warden/pull/178) [`0326eb2`](https://github.com/delacournz/warden/commit/0326eb2740b8520d02666b9f89b0572a8c3c80ff) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS e2e and `warden ui`: when the native `settle` cannot bind the simulator's AX observer (`E_AX_UNAVAILABLE`, `AXObserverAddNotification(4002) failed with AX error -25204 (kAXErrorCannotComplete)`, seen on GitHub-hosted `xcode-27` runners while snapshots read fine by pid), that settle polls snapshot hashes instead of failing the step. After two in a row the session stops asking the helper's settle (each try cost about 3 s), with one log line. A native settle that works in between resets the count. The settle span records `nativeError: "E_AX_UNAVAILABLE"` and `via: "hash"`.
- Updated dependencies []:
  - @delacour/warden-e2e@0.11.0

## 0.10.0

### Minor Changes

- [#176](https://github.com/delacournz/warden/pull/176) [`8690beb`](https://github.com/delacournz/warden/commit/8690beb4f61b42ba2cfa8786c54e47217d8197c7) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` under GitHub Actions annotates each failed test on its spec file at the line it failed (`::error`, `::warning` for an optional spec) and appends a table of failed tests to the job's step summary
  - `warden e2e --json-lines` streams NDJSON on stdout: a `test` event as each test finishes, then a `report` event with the whole report
  - `warden e2e` ends with test totals, the error most failed tests share, and where the evidence is
  - `e2e-report.json`: a failed test carries `line`, where it failed in the spec

- [#171](https://github.com/delacournz/warden/pull/171) [`4b17786`](https://github.com/delacournz/warden/commit/4b177863f4a284806f93475eb3b08fc31f8bd96b) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS e2e and `warden ui`: when the simulator cannot name its frontmost app (seen on GitHub-hosted `macos-26` runners: every snapshot failed with `The simulator's accessibility service did not answer a frontmost request` or `named no frontmost application` while the app drew fine), snapshots are read by pid instead: the app warden launched, else SpringBoard. Before, the host fallback asked the same lookup and failed too.
  - New `WARDEN_SIMD_FRONTMOST_COOLDOWN_S` (default 20, `0` always asks first) sets how long snapshots skip the frontmost lookup after it failed (doubling while it keeps failing, up to 5 min), and `WARDEN_SIMD_FRONTMOST_METHOD` (`window-server` default, `running-board`, `center-point`) sets how the in-sim bridge finds the frontmost app. On GitHub-hosted `macos-26` runners `running-board` makes the first read fast.
  - These accessibility failures are now retryable `E_TIMEOUT` / `E_AX_UNAVAILABLE` instead of `E_INTERNAL`, so a locator keeps polling.
  - `trace.jsonl`: every `driver.snapshot` span names its reader (`backend`). A pid read adds `targetPid` / `targetSource`. A failed snapshot records both readers' errors (`bridgeError`, `axError`, `axReason`) and the helper's state once per failure run: `bridge`, `bridgeLastError`, `hostXcode`, `helperXcode`, `coreSimulator`.

### Patch Changes

- [#172](https://github.com/delacournz/warden/pull/172) [`a708b7b`](https://github.com/delacournz/warden/commit/a708b7be434f90456672323311b31729066b9565) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` dashboard: a running row spins and counts its time up, and the session row is a green dot with the session's age.
  - The selected row is a highlight bar while the list has focus; the right side's first line names the row, its state (`running 12s`, `✓ done 1.3s`, `✗ failed`) and how far the log is scrolled.
  - When a key's row finishes (`s`, `R`, `M` …) the footer shows its outcome for 3 seconds; the header shows `✗ metro exited (<code>)` once Metro dies.
  - The `?` overlay groups warden's keys under navigate, app & device, Metro and perf, and the list footer names `r`, `s`, `M` and `p` while they fit.

- [#173](https://github.com/delacournz/warden/pull/173) [`1f8f46c`](https://github.com/delacournz/warden/commit/1f8f46c1b42fe7026c9092384a9e6f1d2973389a) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS goldens: a build is promoted only when `AutomationEnabled` is on disk in the shut-down golden's Accessibility preferences. The in-sim `defaults write` can exit 0 before it is flushed. A golden already on the machine without it is deleted and rebuilt, and `warden golden import` skips an archive without it.
  - `warden golden export` refuses (exit 1) a golden that was still busy when its first boot's settle wait ran out (`not settled after 300s … using it anyway`). That golden stays usable on the machine, but a CI cache no longer carries it to every later run. The mark lives in the golden's device dir, so an export in a later process sees it too.

- [#167](https://github.com/delacournz/warden/pull/167) [`48fad71`](https://github.com/delacournz/warden/commit/48fad7171aa295db5d8fb5355223e4d6c600a85e) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `@delacour/warden` and its platform packages now link to [warden.co.nz](https://warden.co.nz) as their npm homepage, and `@delacour/warden-e2e` links to the e2e docs.

- [#170](https://github.com/delacournz/warden/pull/170) [`f1742de`](https://github.com/delacournz/warden/commit/f1742dee3abc5a0dc76a3166329ad845cc9c8237) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The `@delacour/warden` and `@delacour/warden-e2e` npm pages carry descriptions and keywords for iOS simulators, Android emulators, AI coding agents and React Native / Expo e2e testing, so npm search finds them.
- Updated dependencies []:
  - @delacour/warden-e2e@0.10.0

## 0.9.0

### Minor Changes

- [#154](https://github.com/delacournz/warden/pull/154) [`323dff6`](https://github.com/delacournz/warden/commit/323dff6c00776b61f1606cbb9c230ee1f09b0858) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden builds import <App.app> --kind simulator-base [--hash <nativeFp>]`: file a Release simulator `.app` built by another CI job as the base `warden e2e` / `warden repack` clone, so a fresh runner repacks its JS in seconds instead of building the native app again. The hash defaults to warden's own fingerprint of the project. The import refuses a device build, an `.app` without a slice for this Mac, another bundle id, a Debug or expo-dev-client build, and an executable that lost its mode bits; an embedded `main.jsbundle` is left out of the cached copy (`strippedBundle` in `--json`). `--hash` is now optional with `--kind`.
  - `warden app fingerprint [platform] --kind dev|simulator|release`: print the native fingerprint that kind's build is cached under, plus its cache hash (`hashes` in `--json`, `<fp>:base` for the simulator base).
  - `warden golden key | export <dir> | import <dir>` (iOS): carry the golden image between machines through a CI cache. `key` prints the golden's name (Xcode build, runtime build, device type and recipe), `export` copies the golden into `<dir>/<name>/`, and `import` registers each archive that matches this machine through `simctl create`, with no CoreSimulator restart. A stale, broken or missing archive is skipped with the reason and the golden is built on first claim as before.

- [#153](https://github.com/delacournz/warden/pull/153) [`ca36e38`](https://github.com/delacournz/warden/commit/ca36e38edea7da8e0173e8291a42ba2d629b18d0) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS e2e and `warden ui`: when the simulator's accessibility bridge stops answering, a `snapshot` no longer times out after 10 s with `E_TIMEOUT`. The read moves to the host accessibility reader after 4 s, the next reads go straight there, and the bridge is asked again 20 s later. Seen on GitHub-hosted `macos-26` runners (3 vCPU), where every spec failed `did not become visible` and the warm-up logged `not warm: snapshot failed: E_TIMEOUT`.
  - iOS `app.launch` waits up to 10 s (was 3 s) for the helper to follow the new process before the first read; it still returns as soon as it does. Launch spans on a slow host no longer show `rebind: "timeout"` on every launch.
  - New `WARDEN_SIMD_BRIDGE_DEADLINE_MS` (default 4000, `0` turns the deadline off) and `WARDEN_SIMD_BRIDGE_COOLDOWN_S` (default 20, `0` never skips the bridge) tune it.
  - The `driver.snapshot` span in `trace.jsonl` now carries `backend` and `fallback` when a read did not come from the bridge, so a CI run shows why.

### Patch Changes

- [#148](https://github.com/delacournz/warden/pull/148) [`7844304`](https://github.com/delacournz/warden/commit/7844304079e81c562043f32bec2ad8a27353e7b1) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Simulated camera on iOS simulators: a video recording stopped before the encoder took its first frame (a short take, or any take on a busy host) no longer fails with "The operation could not be completed"; the recording holds the frame it started on.

- [#152](https://github.com/delacournz/warden/pull/152) [`36586e8`](https://github.com/delacournz/warden/commit/36586e8f6c685da303b1466f9b46d8762b3ae411) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden app ensure --kind dev` now warms the cache `warden dev` reads: one dev build per native fingerprint, keyed `<fingerprint>:dev`, shared by `warden dev`, `warden app ensure` (with or without `--kind dev`), `run|batch --app`, `warden ui open` and `warden e2e --dev`. Before, `warden dev` missed a build `app ensure --kind dev` had made and built its own copy.
  - A dev build cached by an earlier warden under the plain `<fingerprint>` key (or found in a legacy cache dir) is reused as that build, and a device it is already installed on is not reinstalled: no rebuild after upgrading.
  - Applies when the project's own build is the dev build (Debug, default or identical `build` command, no variant, no `fingerprint.include: "native+js"`, no `kinds.dev.env`); other projects keep their kind-less build as before. `warden app ensure` with no `--kind` reports `hash: "<fingerprint>:dev"` and `kind: "dev"` in `--json` for such projects.
- Updated dependencies []:
  - @delacour/warden-e2e@0.9.0

## 0.8.0

### Minor Changes

- [#145](https://github.com/delacournz/warden/pull/145) [`e632b3e`](https://github.com/delacournz/warden/commit/e632b3e46f035c7d8ca0e0d81dfdf4f4d04bc36c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Simulated camera for iOS simulators and Android emulators: feed a png, jpg, heic, mp4 or mov into the app's real camera for preview, photo capture, video recording and QR / barcode scanning.
  - `warden claim android --camera` / `warden dev android --camera`: an emulator whose back and front cameras are fed from files.
  - `device.camera.set(path, { facing, loop })`, `clear(facing)` and `status()` in specs: the path is relative to the spec file, the camera is taken off when the test ends, and the result says whether the feed applies on the app's next launch, its next camera open, or after the emulator rebooted. Missing or unsupported files fail with `E_CAMERA_NOT_FOUND` / `E_CAMERA_MEDIA`, an Android emulator without `--camera` with `E_CAMERA_DEVICE`.
  - Suite `camera: { back?, front? }` in `warden.config.ts` (a path or `{ path, loop }`, relative to the config file): fed before each spec's first `app.open()`, and the suite's Android devices are claimed with `--camera`.
  - `warden ui camera set <path> [--facing back|front|both] [--no-loop]`, `camera status` and `camera clear [--facing …]`: drive the same camera by hand, undone when the lease is released.

- [#133](https://github.com/delacournz/warden/pull/133) [`63948a7`](https://github.com/delacournz/warden/commit/63948a72a764c64260eff05ee857e1868d2194d4) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - A failed device claim now says why with a code and its own exit code: `NO_DEVICE` (5, every matching device leased at `--max`), `QUEUE_TIMEOUT` (6, `--wait` ran out behind other claims), `NO_CAPACITY` (7, no room to boot, with `capacityReason` `ram-budget`, `cpu-budget`, `memory-pressure` or `host-load`), `RUNTIME_MISSING` (9), `HEALTH_FAILED` (10) and `LEASE_LOST` (11); `REQUESTER_LIMIT` (8) is reserved. Exit 1 stays the generic failure.
  - `warden claim`, `run`, `batch` and `e2e` with `--json` print `{ok:false, command, error:{code, message, hint}}` for these, and `warden ui --claim` returns the same codes in its envelope.
  - The human error line drops the code and adds a one-line hint naming the fix.

- [#149](https://github.com/delacournz/warden/pull/149) [`9dfc77b`](https://github.com/delacournz/warden/commit/9dfc77bb8302ab9f5b1c0a906ba79f99933a30ab) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev restart-metro [--clear] [--udid <udid>] [--json]` restarts a running `warden dev` session's Metro on the same leased port from another shell or an agent, keeping the device, leases, installed app and dev client. `--clear` resets Metro's cache; prints the new Metro URL (`--json`: `{ udid, metroUrl, clear }`).
  - The `warden dev` dashboard gains `M` to restart Metro without clearing its cache (`c` still restarts with `--clear`); a restart requested from the CLI shows in the same row and waits for any running restart, reinstall or simulator restart.

- [#142](https://github.com/delacournz/warden/pull/142) [`21f63eb`](https://github.com/delacournz/warden/commit/21f63eba7e1ac033522c5bfd5dd050f6ff604521) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden doctor --leases [--fix] [--json]` checks the lease registry against the machine: a lease on a device that is gone, a booted warden sim nothing tracks, a stale `pending:` placeholder, a queue row with a dead pid, a recorded sim missing from disk, an ownership-marker mismatch, plus stale idempotency keys and orphaned reclaim retry state. Exit 0 when clean, 1 when drift remains; `--fix` deletes only registry rows and never shuts down, erases or deletes a device.
  - Every iOS simulator warden creates now carries a `.warden-owned.json` ownership marker with this warden home's instance id. Shutdown on release, health-monitor reboots, reclaim `erase` / `uninstall`, `warden sims prune`, `warden sims delete` and the ephemeral-sim sweep in `warden gc` leave a sim whose marker names another warden instance alone; sims without a marker behave as before.

- [#128](https://github.com/delacournz/warden/pull/128) [`11084f7`](https://github.com/delacournz/warden/commit/11084f77bd6fc1883b908d1735c44fe6e69a2cac) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS sims are ephemeral: once a warden sim shuts down (`warden release --shutdown`, SessionEnd, `warden gc`, a passed `warden e2e`) it is deleted, and the next claim clones a fresh one from the golden, so old `warden-<profile>-N` sims no longer pile up. Quarantined (`--bad`), foreign and physical devices are kept.
  - `warden gc` (and auto-gc, once per machine for sims an older warden left) deletes every shut-down, unleased warden sim; `release --json` and `gc --json` list them under `deleted`.
  - `warden release --bad --shutdown` quarantines before the shutdown, so the bad sim is kept for `warden sim unquarantine`.
  - `warden dev` keeps its sim: it is shut down but never deleted, so installs and logins survive between sessions. `WARDEN_EPHEMERAL_DEV=1` makes it ephemeral too.
  - `WARDEN_EPHEMERAL=0` (or `WARDEN_GOLDEN=0`) keeps the persistent pool.

- [#128](https://github.com/delacournz/warden/pull/128) [`11084f7`](https://github.com/delacournz/warden/commit/11084f77bd6fc1883b908d1735c44fe6e69a2cac) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden gc` (and auto-gc) prunes stale goldens once a day: iOS golden sims and Android quick-boot snapshots an older Xcode runtime, golden recipe or system image left behind, GBs each. The current golden, an AVD with a running emulator and a profile whose key can't be read are kept, and a golden being built or cloned is skipped, never waited on. `gc --json` lists them under `goldens`.
  - `WARDEN_GOLDEN_PRUNE=0` turns it off; `warden golden prune` still prunes by hand.

- [#139](https://github.com/delacournz/warden/pull/139) [`df471da`](https://github.com/delacournz/warden/commit/df471da5cf5292b33aaa6cfa87b39819886853a6) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden claim --idempotency-key <key>` (or `WARDEN_IDEMPOTENCY_KEY`) makes a claim safe to repeat: the same owner repeating the key while the leases are alive gets the same lease JSON back instead of a new device. A different request under a live key fails with a usage error; the key is free again once the leases are released.

- [#137](https://github.com/delacournz/warden/pull/137) [`b58f440`](https://github.com/delacournz/warden/commit/b58f440e1c47c1e9dd7bca1e8fc2c590d21abe09) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `WARDEN_WARM=1` (off by default) keeps a learned warm pool: `warden gc` boots existing slim, idle warden devices up to the 24 h peak of concurrent leases per platform and profile, queue head's profile first. It acts only at memory pressure `normal`, stays inside the capacity budget, and never creates, or touches foreign, golden, quarantined or physical devices.
  - Warm devices skip the 20 min idle shutdown, and a queued claim evicts them only after every other idle device.
  - `warden capacity` shows the warm pool (`warm.enabled`, `warm.rows` with target, actual and peak per platform and profile in `--json`).
  - Background gc now runs every interval while `WARDEN_WARM=1`.

- [#136](https://github.com/delacournz/warden/pull/136) [`a5c81d4`](https://github.com/delacournz/warden/commit/a5c81d412f20b61c8a4aaf964f38ebfed3cdec1d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Every device lease now leaves a trail in an append-only event log: `requested`, `queued`, `granted` (with the wait), `released`, `expired`, `heartbeat_lost`, `evicted`, `quarantined`, `unquarantined` and `shutdown`. Each row is written in the same transaction as the change it records.
  - New `warden events [--since 1h] [--lease <id>] [--owner <owner>] [--follow] [--json]` prints the history. `--follow` polls every second and, with `--json`, prints one event per line.
  - New `warden stats [--since 7d] [--json|--csv]` reports claims, median and p95 wait, lease durations and peak concurrency per platform and profile.
  - `warden gc` prunes events older than 7 days; `WARDEN_EVENTS_DAYS=<n>` changes the retention.

- [#141](https://github.com/delacournz/warden/pull/141) [`563b2f8`](https://github.com/delacournz/warden/commit/563b2f8018d60616421e8e929aed1d1ec4273dfd) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden run`, `dev`, `batch` and `e2e` now watch the devices they lease: on each 30 s heartbeat a simulator must be Booted in `simctl` and an emulator must answer `adb get-state` with `device`. After two bad reads in a row the device is rebooted under the same lease (waits 5 s, 10 s, 20 s before attempts 1-3, one device at a time) and `warden events` logs `device_unhealthy` and `device_recovered`.
  - When all three reboots fail the run stops with exit 11 `LEASE_LOST` naming the dead device.
  - Physical devices and devices warden did not create are never rebooted: they only log `device_unhealthy` and warn on stderr, and the run goes on.
  - `WARDEN_HEALTH_MONITOR=0` turns the monitor off.

- [#135](https://github.com/delacournz/warden/pull/135) [`c16f8f0`](https://github.com/delacournz/warden/commit/c16f8f09e6f88bfe56c5e3d1a95eb87caf4a22cb) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New opt-in `WARDEN_MAX_PER_OWNER=<n>` (or per platform, `ios=2,android=1`) caps how many separate device claims one owner holds at a time; unset stays unlimited. A claim over the cap waits (shown as `requester-limit` in `warden queue`) while `--wait` time remains, then fails with exit 8 `REQUESTER_LIMIT`, naming the owner's oldest lease and its `warden release <leaseId>`.
  - `warden run`, `dev`, `batch` and `e2e` count as one claim however many devices (`--count`, device legs, extra workers) they take, so the cap never splits a single command.
  - A malformed `WARDEN_MAX_PER_OWNER` (`lots`, `0`, `ios=`) fails the claim with a usage line before anything is leased.

- [#138](https://github.com/delacournz/warden/pull/138) [`ea8b1d7`](https://github.com/delacournz/warden/commit/ea8b1d759ed7376bee5ad388b3beac103657f4d2) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New opt-in `reclaim: erase | uninstall | none` (default `none`) in `e2e` suites, `batches` presets and the top level of `warden.config.ts`, with `WARDEN_RECLAIM` as the fallback below config: when a run releases its devices, warden cleans them. `erase` shuts a simulator down and runs `simctl erase`; `uninstall` removes the user-installed apps. On Android, `erase` uninstalls the third-party apps.
  - A `reclaiming` lease holds the device while it is cleaned, so no claim takes it mid-way. Only warden-created simulators and emulators are reclaimed: foreign, golden and physical devices are skipped.
  - A failed reclaim quarantines the device with a `reclaim: ` reason and `warden gc` retries it after 30 s, then 60 s (capped at 5 min), 3 tries in all. After that it stays quarantined until `warden sim unquarantine <udid>`.

- [#126](https://github.com/delacournz/warden/pull/126) [`f1cc0e6`](https://github.com/delacournz/warden/commit/f1cc0e6dd90e94c4abe408d202d007938845cb11) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Add `warden ui a11y audit|order|speak|announcements|spoken|focus`: audit the screen (`--rule`, `--ignore <rule[:identifier]>`, `--min-severity error|warning`, `--no-native`, `--text-size`; exits 1 when an issue is at or above the severity), print the simulated reading order and the phrase for one element, read announcements and live-region changes (`--since <cursor>`), and read or move real TalkBack focus and speech on Android.
  - Add `warden ui a11y set` flags `--screen-reader`, `--reduce-transparency`, `--button-shapes`, `--differentiate-without-color`, `--on-off-labels`, `--high-contrast-text` and `--color-inversion` (each also `--no-…`). A setting the platform has no mechanism for is reported `skipped`; only skipped settings fail with `E_UNSUPPORTED`.
  - Add `snapshot --a11y` (hint, custom actions, `a11y-focused`, `not-important`, live region per element), `open --a11y`, `warden e2e --a11y`, the `WARDEN_A11Y=1` env var, and the `a11y` suite and top-level config key (`rules`, `ignore`, `minSeverity`, passed to specs as `WARDEN_A11Y_AUDIT`) that launch iOS apps with the injected accessibility library.
  - Add `device.a11yAudit()`, `device.screenReader.*` (`order`, `state`, `next`, `prev`, `activate`, `focused`, `spoken`), `device.announcements()` and `snapshot({ a11y: true })` to `@delacour/warden-e2e` specs, with the matchers `toHaveAccessibleName`, `toHaveRole`, `toHaveHint`, `toAnnounce`, `toBeA11yFocused`, `toPassA11yAudit` and `toHaveAnnounced`.
  - iOS simulators now apply bold text, reduce motion, reduce transparency, button shapes, differentiate without colour and on/off labels live, and a simulated screen reader that makes `AccessibilityInfo.isScreenReaderEnabled()` true.
  - Android emulators gain high contrast text, colour inversion and real TalkBack mode (`a11y set --screen-reader`, needs a Google Play image and `warden-uiad`); release puts the accessibility services back exactly as the device had them. With TalkBack on, `press` and `scroll` use accessibility actions.
  - Audits also run the platform's own engine: XCUITest `performAccessibilityAudit` on iOS simulators and the Accessibility Test Framework on Android emulators. An engine that cannot run is reported `skipped` instead of failing the audit.
  - Android apps now see reduce motion off by default under warden; `reduceMotion: true` (`--reduce-motion`) turns it on.
  - Android emulators are unlocked at boot, which fixes `START_CLASS_NOT_FOUND` when launching an app on a locked emulator.

- [#134](https://github.com/delacournz/warden/pull/134) [`60544c6`](https://github.com/delacournz/warden/commit/60544c6815369445bbaead50fface30dfd56fdc8) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden queue` and `warden queue --json` show a `reason` for every waiting claim: `behind-earlier`, `ram-budget`, `cpu-budget`, `memory-pressure`, `host-load`, `device-limit` (every matching device leased at `--max`) or `waiting-for-device` (no free ready physical device). The reason is stored on the queue row and rewritten every poll.
  - Claims polling for a device now appear in `warden queue` without a position; they hold no boot slot and never delay other claims.
  - The "queued" and "waiting for" progress lines end with the reason in brackets.
  - `warden capacity` uses the same usage and budget check as claims, and `--json` gains `blocked` per platform (`{ ios, android }`: the resource booting one more device would run out of now, or `null`, the same answer a claim gets).

### Patch Changes

- [#126](https://github.com/delacournz/warden/pull/126) [`f1cc0e6`](https://github.com/delacournz/warden/commit/f1cc0e6dd90e94c4abe408d202d007938845cb11) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e --dev` on Android points the dev client at warden's Metro on every `app.open()`, with the onboarding sheet and dev menu off, instead of launching it on its default url

- [#126](https://github.com/delacournz/warden/pull/126) [`f1cc0e6`](https://github.com/delacournz/warden/commit/f1cc0e6dd90e94c4abe408d202d007938845cb11) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` / `warden batch` no longer fail a passing spec because another spec in the same shard failed or because a skipped spec had no result; only the spec with the failed test (or a spec the process never reached after a crash) fails.
- Updated dependencies []:
  - @delacour/warden-e2e@0.8.0

## 0.7.0

### Minor Changes

- [#114](https://github.com/delacournz/warden/pull/114) [`776daf0`](https://github.com/delacournz/warden/commit/776daf07a1dfe8587e24abecd5acf1d07ddf6326) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Add `warden ui biometrics [status|enroll|unenroll|match|fail]`: simulated Face ID, Touch ID and Android fingerprint on warden-claimed simulators and emulators. Answers `{ enrolled, modality }`; a physical device or an Android `enroll` / `unenroll` fails with `E_UNSUPPORTED`.
  - Add `device.biometrics.status()`, `enroll()`, `unenroll()`, `match()` and `fail()` to `@delacour/warden-e2e` specs (`BiometricState`, `DeviceBiometrics` types). Android `enroll` / `unenroll` throw `ACTION_FAILED`.
  - Add the `biometrics` config key (top level, `e2e.<suite>`, `batches.<preset>`; default `false`) and the `--biometrics` flag on `claim`, `run`, `batch` and `e2e`. Devices get the profile `<profile>+bio`, with their own pool and golden snapshot.
  - Android `+bio` devices start from a golden snapshot with a fingerprint already enrolled (screen-lock PIN `1111`); `warden golden ensure --platform android --profile <profile>+bio` builds it ahead of the first claim.
  - iOS `+bio` simulators are enrolled on every boot and again when a spec process starts, before the app is installed.
  - Android `+bio` golden snapshots are saved past the lock screen with the screen kept on; a claim returns once adb, the package manager and the unlocked screen answer, unlocking with the PIN if needed, and an emulator that never gets ready is shut down instead of left locked.
  - `warden ui reload` / `eval` / `logs` and the other devtools verbs find a dev client on a `+bio` simulator (Metro reports the `+` in its name as a space).

- [#117](https://github.com/delacournz/warden/pull/117) [`a0ba85c`](https://github.com/delacournz/warden/commit/a0ba85c8a0bbb21b6cd06e92ee2b8806f2d06fef) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Device conditions set on a lease (network, location, clock, …) are always undone when the lease is released or garbage-collected.
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
  - More conditions: app permissions (`device.permissions.set`, `warden ui permission`), timezone and locale, text size and contrast (`device.a11y`), battery level and charging (Android real, iOS status bar only), Android memory warnings and iOS push notifications. Each is undone when the lease is released.
  - Conditions left behind by a lease that expired or was deleted any other way (including by an older `warden`) are undone before the device is claimed again, and by `warden gc` for unleased devices.
  - On iOS, a network or clock change that cannot tell whether the app is running now fails instead of being staged silently, and another injected app still running on the simulator no longer stands in for the app under test.
  - `device.permissions.set` / `warden ui permission` on iOS retry a `simctl privacy` call that hangs on a simulator that just booted.

- [#118](https://github.com/delacournz/warden/pull/118) [`26c8ce5`](https://github.com/delacournz/warden/commit/26c8ce5e0e28490ea0d2d37400891b0e25863843) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Physical devices: lease, drive and test real Android phones and iPhones/iPads.

  **Claiming**
  - `warden claim --physical` leases a connected phone or tablet; `--serial <serial...>` (Android) and `--udid <udid...>` (iOS) name the devices and imply `--physical`. A plain `warden claim` never takes a physical device, even with `--adopt`.
  - `--physical` is rejected together with `--count`, `--max`, `--slim`, `--headless`, `--runtime` and `--adopt`; `--serial` / `--udid` are rejected on the wrong platform. Leases and `warden claim --json` carry a `physical` field.
  - A physical device is never booted, created, shut down, erased or slimmed: `warden release --shutdown` and `warden gc` leave it running, and it costs nothing in host capacity.
  - An iPhone or iPad is picked only when it is reachable: its tunnel is connected, it is wired, or `devicectl device info lockState` answers within 5 s (20 s for a phone named with `--udid` or `physical.ids`; probes run in parallel). An answer means reachable even when the phone is locked: `warden devices` and `warden doctor` show it as locked. Devices that are listed as available but are offline (an iPad in a drawer) are shown with a reason and never auto-picked. An Android phone that is `unauthorized` or `offline` is never auto-picked either.
  - Naming an unusable device with `--udid` / `--serial` fails `device_offline` with the reason and what to do.
  - `physical: { allow: [...] }` in `warden.config.ts` and `WARDEN_PHYSICAL_IDS` (comma-separated, wins over the config) limit what an id-less `--physical` claim may pick. Naming a device with `--udid` / `--serial` still works for any device. A `warden.config` that cannot be read fails the claim instead of ignoring the list.
  - An id-less `--physical` claim with more than one usable phone (ready, reachable, unleased, on the allowlist) no longer picks silently, in `warden claim`, `warden ui --claim`, `warden e2e`, `warden run` and `warden batch`. In a terminal a picker lists name, model, OS version and transport (cancel = `Aborted.`, exit 1); otherwise, or with `--json`, it fails `ambiguous_device` (exit 2) with `error.details.candidates` and the hint to pass `--udid` / `--serial` or set `WARDEN_PHYSICAL_IDS`. The choice is made once before any lease, build or job; one candidate is still picked without asking.
  - A claim of a locked iPhone (`warden claim`, `run`, `batch`, `e2e`, `ui --claim`) no longer stalls: before any lease warden prints `<name> is locked: unlock it to continue (waiting up to 2m)`, polls `lockState` every 10 s with a progress line about every 30 s, and continues once the phone is unlocked. Still locked after 2 minutes, or with `--no-wait`, it fails `device_locked` (exit 2, hint `unlock the phone, then retry`; `--json` error code `device_locked`). No lease is held while waiting.
  - A claim that polls for a device (a named phone that is offline, a pool that is fully leased) now prints `waiting for …` and `still waiting …` lines about every 30 s instead of staying silent until `--wait` runs out.

  **Android phones**
  - `warden ui` drives Android phones: `--serial <adb serial>` (USB, `ip:port` or wireless-debugging serials) or `--claim --physical`. It exits 2 with `device_unauthorized` (accept the USB debugging prompt) or `device_offline`; the lease is kept.
  - A device with qemu properties set (`localhost:5555`, Genymotion) is a foreign emulator, never a phone.
  - warden wakes the screen and dismisses a keyguard with no credential; a PIN, pattern or password lock fails `E_DEVICE_LOCKED` and warden never unlocks it. Rotation, dark mode and animation scales are saved before the first change and restored on close.
  - `uninstall` and `clear data` refuse any package warden did not install (`E_REFUSED`, `physical_protected`). Installing an APK checks its ABIs first and fails `abi_mismatch` with a hint to use the `dev` or `release` kind; `INSTALL_FAILED_UPDATE_INCOMPATIBLE` says to uninstall the differently-signed copy yourself.
  - `test.use({ systemAlerts })` and `device.alert` close the "Save password to Google Password Manager?" sheet with Back for both `accept` and `dismiss`; warden never presses Never or Continue.

  **iPhones and iPads**
  - `warden claim ios --physical` and `--udid <udid>` lease paired devices listed by `devicectl`; a paired device with Developer Mode on and reachable is ready. `warden ui --udid <iPhone udid>` (or `--claim --physical`) starts an on-device XCUITest runner once, then `snapshot`, `press`, `fill`, `type`, `swipe`, `screenshot`, `open` and the rest talk to the phone through it.
  - Single-finger input only: `pinch`, `rotate`, `gesture`, `press shake` and `press back` fail `E_UNSUPPORTED`. On an iPhone `screen appearance` is read-only, `screen rotate` goes through `devicectl`, and a locked phone exits 2 with `device_locked`.
  - `ios: { teamId, runnerBundleId }` in `warden.config.ts` and `WARDEN_IOS_TEAM_ID` choose the Apple team that signs the runner; without them warden uses the keychain's `Apple Development` team when there is exactly one and fails `ios_team_ambiguous` listing the teams otherwise.
  - The runner is built with `xcodebuild build-for-testing -allowProvisioningUpdates`, cached per team and Xcode build, and rebuilt for a new phone or when its provisioning profile ends within 24 hours. Failures carry a code and a hint (`no_account`, `no_team`, `bundle_id_taken`, `device_locked`, `developer_mode_off`, `runner_untrusted`, `ui_automation_disabled`, `device_busy`, `ddi_unavailable`, `unsupported_os`).
  - `fill` and `press` on an iPhone type one character at a time so a React Native field keeps every key, and Backspace, Enter, Tab and Space are typed on the software keyboard (a retry now clears the field).
  - The resident iPhone runner host records which runner build it serves; when the runner changes (a new warden, an edited runner source) the next `warden ui` / `warden e2e` replaces the host and prints `runner changed; restarting the iPhone runner host`, so no manual restart is needed. A phone leased to another session keeps its host and fails `device_busy` (exit 2) instead.

  **Tests**
  - `warden e2e`, `warden run` and `warden batch` take `--physical`, `--serial` and `--udid`; `physical: true | { ids }` on an e2e suite or device leg does the same, and the flags win. A physical run never reboots, hides, arranges, slims, golden-clones or shuts down a device, and a suite `setup` command still runs. `WARDEN_UDIDS` carries the adb serial / CoreDevice UDID and each job of a phone gets `WARDEN_DEVICE_KIND=physical`.
  - A physical e2e run installs the `release` build kind by default (an explicit `--kind` or the suite's `app.kind` wins). On an iPhone, `--app` (or a suite `app`) builds the app for the device and installs it with `devicectl` (see Device builds).
  - On an iPhone, `warden e2e` starts the runner host before the specs and stops when it cannot (a locked phone exits 2 with `device_locked` and an unlock hint, no spec runs, `e2e-report.json` carries `error`); a lost runner connection restarts it once and reruns the test, and the phone is never rebooted.
  - `test(title, { requires: ["pinch" | "multiTouch"] }, body)` skips a spec on a device whose driver lacks the capability (a physical iPhone has neither).

  **Device builds**
  - `warden app ensure ios --udid <iPhone> --kind release|dev`, `warden e2e --udid <iPhone>` and `--app` on `run` / `batch` build the app signed for the phone (`xcodebuild -destination generic/platform=iOS -allowProvisioningUpdates`, team from `WARDEN_IOS_TEAM_ID`, `ios.teamId` or the keychain) and install it with `devicectl device install app`. The build is cached apart from simulator builds, keyed on the team; with no `--kind` an iPhone gets `release`. `--kind simulator` and `--variant` are refused on an iPhone.
  - `projects[].ios.device.bundleIdentifier` in `warden.config.ts` replaces the bundle id on a phone (and is the specs' `WARDEN_BUNDLE_ID` there) when your app's id belongs to another Apple team.
  - `--install-mode reinstall|clean` on an iPhone uninstalls and reinstalls (app data cannot be wiped in place); `--reset-keychain` is refused. A phone that the app's provisioning profile does not list is registered automatically: warden builds once with `-destination id=<udid>`, rebuilds the cached device build and installs again (once per phone); `device_not_in_profile` is reported only if that does not help.

  **Output and diagnosis**
  - `warden devices` has a `KIND` column (`virtual` or `physical`), shows why a physical device is unusable (`unauthorized`, `offline`, `unpaired`, `developer mode off`) with a hint, and takes `--physical` to list only phones and tablets; `--json` rows carry `kind`, `transport` and `hint`. `warden ls` tags physical leases.
  - `warden doctor` adds `ios-team`, `ios-devices`, `ios-runner` and `android-devices` rows, only when a phone or a signing team exists.
  - The warden skill gains a physical-devices reference.

### Patch Changes

- [#114](https://github.com/delacournz/warden/pull/114) [`776daf0`](https://github.com/delacournz/warden/commit/776daf07a1dfe8587e24abecd5acf1d07ddf6326) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - An Android app install is no longer skipped on a matching key alone: the emulator's installed `base.apk` must have the cached apk's sha256, so an emulator holding an older build of the same native build (an older `warden repack`, a restored snapshot) gets the current one without `--install-mode reinstall`. A truly identical build is still kept.

- [#114](https://github.com/delacournz/warden/pull/114) [`776daf0`](https://github.com/delacournz/warden/commit/776daf07a1dfe8587e24abecd5acf1d07ddf6326) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `device.alert` on iOS answers `true` only once the alert is gone: a press that lands while the sheet is still animating in (LocalAuthentication's "Face Not Recognized") is pressed again, and an alert that survives three presses throws `ACTION_FAILED` instead of reporting it answered.

- [#115](https://github.com/delacournz/warden/pull/115) [`cc761a1`](https://github.com/delacournz/warden/commit/cc761a192ca0e85bf793a09739e6dd295cdd09ac) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `fill`, `type` and `warden ui fill` / `warden ui type` no longer drop or reorder the first letters of the text in a controlled React Native input (`"Hllo"`, `"Hllo, World 123!e"`): the helper now waits 60 ms between the first key and the second, while the field re-renders on its first change
  - `WARDEN_SIMD_LEAD_MS` sets that pause (0 turns it off)

- [#119](https://github.com/delacournz/warden/pull/119) [`d2d728f`](https://github.com/delacournz/warden/commit/d2d728fd14c4ea22ceada794eb31668ba583fd5c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Two `warden dev` (or `--app`) runs on one checkout no longer both build the app: one local build runs per checkout and platform, the other waits (`waiting for the app build…`), then installs that build. A run that read its fingerprint while the other build was prebuilding now waits too, instead of building in the same tree and removing its `ios/` mid-build.
  - A waiting run shows the running build's output live in its own log, from the first line.
  - A checkout that changed while waiting, with nothing cached for the new fingerprint, fails with `the <platform> checkout changed since it was fingerprinted (A → B)`; run again.

- [#118](https://github.com/delacournz/warden/pull/118) [`26c8ce5`](https://github.com/delacournz/warden/commit/26c8ce5e0e28490ea0d2d37400891b0e25863843) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Biometrics on a physical device are refused up front instead of being silently ignored: `--biometrics` with `--physical` / `--serial` / `--udid` fails the claim (`claim`, `run`, `batch`, `e2e`, `ui --claim`), and an `e2e` suite that sets both `physical` and `biometrics` is refused when `warden.config.ts` loads.
  - `device.biometrics` and `warden ui biometrics` fail with `E_UNSUPPORTED` on a physical iPhone, as they already did on an Android phone: a real Face ID / Touch ID sensor cannot be enrolled or matched. A session on a phone never tries to enroll.

- [#118](https://github.com/delacournz/warden/pull/118) [`26c8ce5`](https://github.com/delacournz/warden/commit/26c8ce5e0e28490ea0d2d37400891b0e25863843) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Device conditions and settings (`warden ui network|location|clock|permission|timezone|locale|a11y|battery|memory-warning|push`, `device.network`, `device.location`, `device.clock` and the other spec condition APIs) fail with `E_UNSUPPORTED` on a physical iPhone or Android phone, before anything reaches the phone: warden never flips a phone's airplane mode, clock, timezone or font scale.
  - An `e2e` suite that sets both `physical` and `conditions` is refused when `warden.config.ts` loads.
- Updated dependencies []:
  - @delacour/warden-e2e@0.7.0

## 0.6.0

### Minor Changes

- [#111](https://github.com/delacournz/warden/pull/111) [`28085a6`](https://github.com/delacournz/warden/commit/28085a66a50170c91e1dc0d72ff12da632f2251e) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `fill` (`locator.fill`, `warden ui fill`) types the text key by key by default again; `via: "paste"` / `--via paste` keeps the one-Cmd+V paste on iOS as an opt-in. On Xcode 27 every simulator's pasteboard is synced with the Mac clipboard in both directions, so a paste put e2e values (emails, passwords) into the Mac clipboard and clipboard managers, and during a parallel `warden e2e` / `warden batch` run onto the other simulators' pasteboards, where another test could paste them.
  - `warden ui record` journals `via: "paste"` when a fill was pasted and nothing when it was typed; the generated spec passes `{ via: "paste" }` only. Recordings with `via: "type"` still load and generate a plain `fill`.

- [#107](https://github.com/delacournz/warden/pull/107) [`81c409a`](https://github.com/delacournz/warden/commit/81c409ab1bba1426eea8b64e4d41fa8e06828878) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Every command run with `--json` now prints one JSON document on stdout when it fails, too: `{"ok":false,"command":"<command>","error":{"code":"usage"|"failed","message":"…"}}`. `usage` is an unknown option or a missing argument, `failed` the rest; the exit code and the red line on stderr are unchanged. Commands that already print their own failure document (`warden ui`, `warden perf`, `warden release`) keep it.
  - `warden dev logs --json` failures add `"ok": false` and `"command": "dev logs"` beside `error`.

### Patch Changes

- [#107](https://github.com/delacournz/warden/pull/107) [`81c409a`](https://github.com/delacournz/warden/commit/81c409ab1bba1426eea8b64e4d41fa8e06828878) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `--json` output larger than 64 KB is no longer cut off when the reader is slow to start (an agent, `jq` behind another step): warden waits for stdout to flush before it exits
  - `warden dev --json` prints its `{ udid, port, metroUrl, leaseIds, source }` document on one line, so the first stdout line is the whole document as documented
  - `warden run --json` prints its summary on one line and sends the child's stdout to stderr, so stdout holds only the JSON document
- Updated dependencies []:
  - @delacour/warden-e2e@0.6.0

## 0.5.0

### Minor Changes

- [#56](https://github.com/delacournz/warden/pull/56) [`d97701e`](https://github.com/delacournz/warden/commit/d97701e96ab61b5598ecb6ddfe9ae817346f3f91) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui` on Android keeps one resident host per emulator, which holds the adb shell, `warden-uiad` and animations-off open between calls: `snapshot -i` takes about 90 ms (was 0.6-6 s) and `press` about 120 ms (was about 570 ms). The host starts on the first call and exits after 10 idle minutes, on `warden ui close`, or when the device is released. `warden ui status` shows it as the helper.
  - `WARDEN_ANDROID_HOST_IDLE_TIMEOUT` sets the host's idle exit (`2m`-style). `WARDEN_ANDROID_HOST=0` drives the emulator in-process, as before. A host that cannot start falls back to in-process with a note on stderr.
  - `warden batch` stops a resident host before it prepares its emulators.

- [#109](https://github.com/delacournz/warden/pull/109) [`2120021`](https://github.com/delacournz/warden/commit/2120021f8b7c505d2c0723163a5c34cd5258c689) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New `warden repack ios|android [--project <dir>] [--force] [--json]`: bundles this worktree's JS into the cached simulator build in seconds (the native base is built once per native fingerprint) and prints the base hash, `jsKey`, artifact, `reused` / `repacked`, bundle time or the fallback reason. Exit 1 when Android images changed and no repack is possible.
  - Build kinds: `projects[].kinds.<dev|simulator|release>` (`build`, `env`, `jsInputs`) and `app: { kind }` in an e2e suite. `simulator` is a Release build with no JS embedded plus a per-JS repack keyed by content, not branch; `release` embeds the JS; `dev` is the Debug dev client.
  - `warden e2e` now defaults to the repacked simulator build, repacked once before the devices install: a JS edit no longer rebuilds native. A suite's `metro` block applies only with `--dev` (or when the suite pins `app.kind: "dev"` / `app.variant`). Suites with `app.variant` behave as before.
  - `warden e2e --dev` runs the dev client on a Metro warden starts (the suite's `metro` block, or the defaults); `--kind dev|simulator|release` picks the build. They can't be combined with each other or with `--variant`.
  - `warden app ensure`, `run`, `batch` (`--app`) and `warden ui open` take `--kind`; `warden ui open --kind simulator|release` installs that build, relaunches when it changed and launches without Metro. Defaults are unchanged without the flag.
  - A project's `fingerprint.include: "native+js"` now warns once on stderr when a run asks for `--kind dev` or `simulator`, which key on the native fingerprint.
  - `warden builds ls` shows each build's kind, base, jsKey, worktree, branch, size and age; `--json` carries them.
  - The claim spinner of `warden e2e`, `batch` and `run --app` now says what the app is really doing (building the ios app (fingerprint …), fetching the EAS build, repacking JS, waiting for another device's build) and only says installing once an install actually starts.
  - Android repacks sign with the project's `android/app/debug.keystore` when present.

- [#103](https://github.com/delacournz/warden/pull/103) [`2052caa`](https://github.com/delacournz/warden/commit/2052caa0f3706f815bb1f5e967b4cbab232ccc5e) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` now runs only what the agent loop needs (dev build, Metro, simulator, app): the perf HUD sampler and the CDP devtools broker are off by default. `--hud` and `--devtools` start them with the session; `--no-hud` is still accepted.
  - New `warden dev enable <hud|perf|devtools|all>`, `warden dev disable …` and `warden dev status [--udid] [--json]` turn those extras on and off in a running `warden dev` from another shell.
  - The dashboard's `h` key now starts and stops the HUD sampler instead of only hiding the box.
  - The mouse wheel no longer moves the task selection in the `warden dev` dashboard.
  - `warden ui` devtools verbs on a session without a broker hint `warden dev enable devtools`.

- [#105](https://github.com/delacournz/warden/pull/105) [`4e918b5`](https://github.com/delacournz/warden/commit/4e918b51602251b9a554783d49f651285fb22f04) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e`: a passed gate now shuts down the sims / emulators warden created (and closes their windows) locally too, not only under `CI`. Set the suite's `shutdown: "idle"` to keep them booted for the next run, or pass `--no-shutdown`.

### Patch Changes

- [#102](https://github.com/delacournz/warden/pull/102) [`89f56fe`](https://github.com/delacournz/warden/commit/89f56fe2bab718926872e9f5d2bea2a02eadbb5b) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` specs on a dev client (`WARDEN_METRO_URL`) run with React Native's LogBox off: no warning/error toasts and no error inspector cover the app or take taps, fatals included, after every relaunch and JS reload too. Logs still reach `console.jsonl` and Metro's terminal.

- [#110](https://github.com/delacournz/warden/pull/110) [`ba0c2cc`](https://github.com/delacournz/warden/commit/ba0c2cca86cb48eadcdf61b10351077f44aaaa10) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` bundles a `simulator` / `release` run's JS with the suite's `metro.env`, so `EXPO_PUBLIC_*` values such as a fake backend URL reach the repacked build (and its cache key) instead of `.env*` or the shell's values
- Updated dependencies []:
  - @delacour/warden-e2e@0.5.0

## 0.4.0

### Minor Changes

- [#94](https://github.com/delacournz/warden/pull/94) [`f672d27`](https://github.com/delacournz/warden/commit/f672d27add2101afa452375f85d34308755fd316) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden builds rm <hash…>` (alias `remove`) removes cached builds by hash or a unique prefix (at least 6 characters), with their aliases, and forgets the install records at those hashes so the next `warden dev` / `warden app ensure` reinstalls on those devices. `--platform`, `--dry-run`, `--yes` and `--json` (`{ dryRun, removed, forgotInstalls }`) are supported. It asks first in a terminal, and refuses a prefix that matches several builds or a build being fetched or built right now.

- [#89](https://github.com/delacournz/warden/pull/89) [`14b0f3a`](https://github.com/delacournz/warden/commit/14b0f3a03ee885b287b634b8db552ded86eead34) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev`: declining the `warden.config.ts` offer for an app read through `expo config` now writes the config to the repo's overlay under `~/.warden/projects/<repo>/` instead of skipping it, so later starts (from any worktree or branch of the same repo) skip the `expo config` call without a file in the checkout. A monorepo app gets `root` set to its path from the checkout. A `warden.config.ts` in the repo always wins over the overlay one.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` draws a dashboard on an interactive terminal: task rows on the left (claim device, show simulator, dev build, metro, dev client, session), the selected row's live output on the right, and Metro's own terminal in the metro row. `--no-tui` or `WARDEN_TUI=0` keeps the plain output; `--json`, pipes and CI are always plain.
  - The dashboard has two modes. List mode takes warden's keys; `Enter` or `i` on the metro row sends every key to Expo (`a`, `i`, `w`, `j`, `r`, `m`, `o`, `?`) until `Esc`, `Esc Esc` sends a literal Esc, and `Shift+PgUp` / `Shift+PgDn` scroll Metro's history. `?` lists the keys.
  - Action keys in list mode: `r` reload, `d` show the simulator, `o` open the dev client, `s` screenshot, `R` reinstall the dev build, `x` restart the simulator (iOS), `c` restart Metro with `--clear`, `l` stream device logs, `h` toggle the HUD, `q` quit and release.
  - The perf keys drive `warden perf` sessions from the dashboard: `p` starts and stops a session, `P` records every capture, `m` asks for a mark label, `f` reads frames (Android) and `g` shows the report. One session records per device, and `R` and `x` are refused while it does.
  - A perf HUD at the top right (terminals 100 columns or wider) shows CPU with a short history, memory (RSS on iOS, PSS on Android), fps and jank (Android), Metro's last bundle time and the recording clock. `--no-hud` turns it off and `--hud-interval <duration>` sets the sampling interval (default `1s`, minimum `200ms`).
  - Each dashboard session writes `warden.log`, `metro.log` and `shots/` under `$WARDEN_HOME/dev/<leaseId>/`; `warden gc` removes a session directory once its lease is gone and its files are 24 hours old.
  - `perf metrics --watch` on iOS costs ~1% of a core instead of ~16%: the app's pid is resolved once and each sample is one pid-scoped `ps`.

- [#91](https://github.com/delacournz/warden/pull/91) [`cea00ce`](https://github.com/delacournz/warden/commit/cea00cec65ce7714fca1a6e615b17e1790a4e7c2) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` holds one devtools connection to the app for the whole session (the dashboard's `devtools` row). It captures console lines, uncaught exceptions and `fetch` calls from launch, and `warden ui` devtools verbs read from it instead of opening their own connection. Without a dev session they connect directly as before.
  - `warden dev logs` reads Metro's output, classified as `bundle_start`, `bundle_done`, `bundle_failed`, `hmr`, `error`, `warn` and `info`, with file, line and code frame for bundle and transform errors. It takes `--since`, `--tail`, `--grep`, `--kind`, `--follow` and `--json`.
  - New `warden ui exceptions`, `warden ui route` and `warden ui devtools status|resume`. `warden ui logs` and `warden ui network` gain `--since`, `--level`, `--grep`, `--status` and `--limit`.
  - Exception and console stacks are symbolicated through Metro to source file and line, with Metro's code frame. Errors React Native reports through its exception handler count as exceptions.
  - `warden ui logpoint add <file:line[:col]> '<expression>'` logs a value every time a source line runs, without pausing the app or editing code. `--hits <n>` removes it after n hits. It comes with `logpoint list|rm|clear|hits`. Logpoints are set again after a reload and end with the session. They need the Fusebox debugger.
  - `warden perf js` records through the dev session's connection when `warden dev` runs. Other perf captures hand the connection back when they finish.
  - `warden perf js` hotspots now map to source on React Native apps, which load their bundle as `index.bundle//&…`.
  - When Chrome DevTools takes the app on a Metro that allows one debugger, the session's connection waits instead of taking it back. `warden ui devtools resume` reattaches.
  - `warden mcp` is an MCP server on stdio. Its tools are `dev_sessions`, `metro_logs`, `app_console`, `app_exceptions`, `app_network`, `app_eval`, `app_tree`, `app_route`, `app_reload`, `logpoint_add|hits|list|remove`, `profile_start|stop|status` and `devtools_status|resume`.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` (and every command that finds the project) works from a monorepo root without a `warden.config.ts`: when nothing is found upwards it looks below, in the package.json `workspaces` (else `apps/*` and `packages/*`). One app there is used and named; with several, `warden dev` asks which one, and a pipe gets the list and `--project <dir>`.
  - `warden dev` runs bare React Native apps. An app whose package.json depends on `react-native` but not `expo` gets its bundle ids from `ios/*.xcodeproj` and `android/app/build.gradle`, Metro as `react-native start` on the leased port, `react-native build-ios` / `build-android` as the default local build, and is relaunched against Metro (`-RCT_jsLocation` on iOS, port 8081 reversed on Android). No `expo-dev-client` is asked for. `c` restarts Metro with `--reset-cache`.
  - New `projects[].framework` (`"expo"` | `"react-native"`) in `warden.config.ts` overrides the guess from package.json.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` resolves an app whose config is code (`app.config.ts` / `.js` / `.mjs` / `.cjs`) without a bundle id in `app.json`: it runs `expo config --json --type public` in the app directory once and takes the bundle id, slug and scheme from the result, instead of stopping with "app.config.ts is dynamic". `--bundle-id` still overrides it and a `warden.config.ts` skips the call. The same applies to every command that finds the project this way (`warden app`, `warden e2e`, `warden run`).
  - `warden dev` checks the request and the app before it leases a device or opens the dashboard, and a failure there is one line with the fix on the terminal. With a person at the terminal each missing piece is offered: a package the dev-client run needs (`expo-dev-client`) is added and installed through the checkout's package manager (`yarn` / `pnpm` / `bunx` / `npx` `expo install`, from the nearest lockfile), and an app read through `expo config` can get a `warden.config.ts` with the resolved ids so later starts skip the call (run through the checkout's prettier when it has one). Without a terminal (`--json`, a pipe) the blocking issues are the error, each with its command.
  - The dashboard no longer swallows a failure: when the session never comes up, or Metro dies, warden's lines are printed to the terminal after the dashboard has closed, with the session log directory.
  - `warden init` names the install command for the checkout's package manager instead of always `bunx expo install`.

- [#97](https://github.com/delacournz/warden/pull/97) [`b590263`](https://github.com/delacournz/warden/commit/b5902636c9542d661f5272afb1c376e10872b404) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` and `warden ui record stop` no longer need bun installed: warden runs the specs with the bun built into its own binary. `WARDEN_BUN` still picks a different bun.

- [#85](https://github.com/delacournz/warden/pull/85) [`764ef1b`](https://github.com/delacournz/warden/commit/764ef1b576228227020bbc14f08e5ae70c5ff057) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - On iOS, `fill` pastes the text with one Cmd+V instead of typing every character, about 400 ms whatever its length. Secure fields are pasted too.
  - `locator.fill(text, { via: "paste" | "type" })` and `warden ui fill --via paste|type` choose how the text goes in; `paste` is the default and `type` keeps the old key-by-key typing. Android always types.
  - A paste that cannot be confirmed on the simulator pasteboard is typed in the same attempt, and the retry after a failed read-back always types, so a field that mangles a paste (a mask, a `maxLength`) still passes.
  - `warden ui record` writes `via: "type"` on a fill step that was typed, and the generated spec passes `{ via: "type" }`; existing recordings are unchanged.

- [#82](https://github.com/delacournz/warden/pull/82) [`84ae25c`](https://github.com/delacournz/warden/commit/84ae25c64e9e7cea91b3f2eb7c51e1fb4e477a04) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Every iOS simulator warden creates boots already slim by default. `--slim` / `--no-slim` on `claim`, `run`, `dev`, `batch` and `e2e`, config `slim` (top-level, `e2e.<suite>.slim`, `batches.<name>.slim`) as `true | false | { except, keep }`, and `WARDEN_SLIM=0` choose per run, per suite or per machine.
  - The slim overrides are written to the simulator before its first boot, so clones come up slim with no per-daemon spawns. Once the sim is ready they are read back, and any drift is fixed live.
  - `warden sim slim --except <categories>` and `--keep <labels>` leave whole categories or single `com.apple.*` labels running. `warden sim profiles` lists the categories.
  - `warden sim measure [udid|--booted]` prints a booted simulator's real memory (summed `phys_footprint`) and its heaviest processes. `warden devices --mem` adds the figure to the device list.
  - `warden capacity` counts a slim simulator at 1792 MB and a stock one at 4096 MB (measured, up from 2048), so admission matches what simulators really use. `cost.ios.memMb` and `cost.ios.slimMemMb` override them.
  - `gamed` and `nanotimekitcompaniond` are no longer disabled, and are re-enabled on a simulator an older warden already slimmed.
  - A plain `warden claim` no longer restores a slimmed simulator. `warden sim slim --restore` does.

### Patch Changes

- [#90](https://github.com/delacournz/warden/pull/90) [`085f760`](https://github.com/delacournz/warden/commit/085f760ab3c77adecc690dbd272ca54edfcf7401) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden claim`, `warden run` and `warden dev` say what a claim is doing while it creates or boots a device (`creating …`, `… booting`, `… waiting until it is ready`), so `warden dev`'s claim row is no longer blank during a slow boot. A warm booted device is still claimed silently.

- [#99](https://github.com/delacournz/warden/pull/99) [`eb5f896`](https://github.com/delacournz/warden/commit/eb5f896f3d47bdc7a478e4b1a59362bbe9a67e7f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Every simulator warden shuts down now has its viewer window closed, not only the one `warden dev` stops on a clean exit: `warden release --shutdown`, SessionEnd, `warden batch`, `warden gc` (stale leases and idle sims) and the capacity gate's idle shutdown. On Xcode 27 this stops Device Hub windows offering "Start" from piling up after a `warden dev` session whose terminal was closed.

- [#90](https://github.com/delacournz/warden/pull/90) [`085f760`](https://github.com/delacournz/warden/commit/085f760ab3c77adecc690dbd272ca54edfcf7401) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev`'s dashboard streams the local build's own output (`expo run:ios`, xcodebuild, Gradle) into the dev build row while it runs, instead of showing nothing until the build ends. The `R` reinstall action streams it into its row too. Plain output (`--no-tui`, `--json`, pipes, agents) is unchanged.

- [#94](https://github.com/delacournz/warden/pull/94) [`f672d27`](https://github.com/delacournz/warden/commit/f672d27add2101afa452375f85d34308755fd316) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev`, `warden app ensure` and `warden run --app` no longer cache a dev build made from a stale git-ignored `ios/` / `android/` dir. When the native fingerprint has changed since that dir was prebuilt (a new native dependency such as `expo-application`), or warden does not know which fingerprint it was prebuilt for, the local build removes it first so `expo prebuild` and `pod install` run again. Before, the build skipped both and linked none of the new native modules, so the dev client crashed with `Cannot find native module '<X>'`. A committed native dir, and a custom `build` command that does not run `expo prebuild` / `expo run:*`, are left as they are.

- [#93](https://github.com/delacournz/warden/pull/93) [`87ea71a`](https://github.com/delacournz/warden/commit/87ea71a6d73e8a5712757b44db63229e9e982cc1) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden claim` / `warden dev` no longer queue forever on macOS when the kernel reports memory pressure `warn` while plenty of memory is free: a kernel `warn` now holds the boot queue only when `memory_pressure` also shows under 25% free (`critical` still always holds). `warden capacity` shows the same reading.
  - `warden dev`'s dashboard shows the claim's progress under the claim row (`queued [#1](https://github.com/delacournz/warden/issues/1) of 1 (high) — memory pressure warn` and similar), instead of sitting on "preparing the ios dev build" with no output.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` boots a held simulator that is shut down (`--udid`, `--lease`, or the device lease an earlier session in the same shell left behind) and waits for it before installing, instead of opening Device Hub on a stopped sim and failing with "Unable to lookup in current state: Shutdown". It only boots a device under the session's own lease; a shut-down device that is not yours is an error naming it.

- [#98](https://github.com/delacournz/warden/pull/98) [`305da73`](https://github.com/delacournz/warden/commit/305da73f29e53db118bfb304fc8360f1cf725620) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` on iOS opens the Expo dev client without the dev menu's first-run onboarding sheet or the dev menu covering the app at launch. The dev menu stays reachable by shake, ⌃D or the floating button.
  - The warden skill says `warden dev ios` opens without the sheet, and that `warden ui open --relaunch` can still show it.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` shows the simulator it leased: once the device is held it brings the sim's window to the front, launching Device Hub (Xcode 27) or Simulator.app (Xcode ≤ 26) when no viewer is running, instead of leaving the window behind other apps or never opening one. `--headless` skips it; a viewer that can't be opened is a warning, not a failure.
  - `warden dev` shuts the simulator it booted down when it ends (Metro exits, Ctrl-C, a kill), and closes its Device Hub / Simulator.app window, instead of leaving it running until `warden gc` with a window behind. A sim that was already booted when leased, or one given with `--udid` / `--lease`, is left on. `--no-shutdown` keeps dev's own sim booted.
  - `warden dev` and `warden run` treat the terminal going away (SIGHUP) like Ctrl-C: the child is stopped and the leases released.

- [#81](https://github.com/delacournz/warden/pull/81) [`2960539`](https://github.com/delacournz/warden/commit/296053972bf3d48a736991b79a844ab9394adfa9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - A `settle` no longer counts as input for the stable-frame rule: an action right after `app.open()` or a `device.settle()` that reported quiet trusts its one look instead of taking a second snapshot.
  - On iOS, an action whose look followed a tap or a key within 300 ms confirms that its element has stopped moving with one hit-test instead of a second whole-screen snapshot (not with `systemAlerts` set, where the full look is what finds an alert).

- [#85](https://github.com/delacournz/warden/pull/85) [`764ef1b`](https://github.com/delacournz/warden/commit/764ef1b576228227020bbc14f08e5ae70c5ff057) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS typing is about 2.6x faster: the default key pacing drops to 5 ms after a key, 20 ms hold and 50 ms before a repeated key, down from 30, 40 and 300 (about 38 ms per character instead of 99 on a local simulator).
  - `WARDEN_SIMD_PACE_MS`, `WARDEN_SIMD_HOLD_MS` and `WARDEN_SIMD_REPEAT_GAP_MS` and the `paceMs`, `holdMs` and `repeatGapMs` request fields still override the defaults.
  - The typing delays no longer go through the simulator library's timers, so a loaded host (a CI VM) stops stretching them into several times the requested pause.

- [#83](https://github.com/delacournz/warden/pull/83) [`51bb4ce`](https://github.com/delacournz/warden/commit/51bb4ceea6f7476c061e3852cea6d46215a4f27d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `app.launch`, `app.terminate` and `app.openUrl` (every spec `app.open`, `device.openLink` and `warden ui open`) run inside the resident `warden-simd` helper instead of spawning `xcrun simctl` for each call: the helper already holds CoreSimulator, which every `simctl` process loaded again (about 0.13 CPU-s on the host per launch, roughly 40 % of warden's host CPU per bench rep). Launch arguments and environment reach the app as before, `relaunch: false` keeps a running instance, terminating an app that is not running is still a success, and the `driver.app.launch` span now carries `via` (`simd` or `simctl`) and the app's `pid`.
  - A helper built before these ops answers once and the driver falls back to `simctl` for the rest of the session (`[ios] this warden-simd predates the \`launch\` op …`in the log; restart it with`warden ui close --udid <udid>`or rebuild with`bun run --cwd packages/e2e native:build`). Install, uninstall, `isRunning`and`clearData`stay on`simctl`.

- [#96](https://github.com/delacournz/warden/pull/96) [`24d04ed`](https://github.com/delacournz/warden/commit/24d04edc9d26953e9b9c886a4811c1e68c9a4340) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The warden agent skill (`warden skill install`, `warden install`) matches the current CLI: `warden builds`, `warden dev logs`, `warden mcp` tools, `warden perf` subcommands, `warden ui` devtools verbs and the flags added since 0.3 are documented, and stale defaults and error codes are corrected.

- [#100](https://github.com/delacournz/warden/pull/100) [`e1f6732`](https://github.com/delacournz/warden/commit/e1f673248319d03754135ebe95aac77a371e2250) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui open <bundleId> --metro <url>` on iOS launches the Expo dev client the way `warden dev` does: no dev menu onboarding sheet and no dev menu at launch. Your `--args` follow those flags.
- Updated dependencies []:
  - @delacour/warden-e2e@0.4.0

## 0.3.1

### Patch Changes

- [#74](https://github.com/delacournz/warden/pull/74) [`6b3ffea`](https://github.com/delacournz/warden/commit/6b3ffea079bcfc3ce73278b2d3f328899f449e46) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `bun run release <version>` asks npm about every package before writing the version or building: a version already published for all of them is reported and skipped without touching the tree, and packages that already have it are listed as skipped up front.
- Updated dependencies []:
  - @delacour/warden-e2e@0.3.1

## 0.3.0

### Minor Changes

- [#72](https://github.com/delacournz/warden/pull/72) [`b00d1e3`](https://github.com/delacournz/warden/commit/b00d1e38c77c7df31e5668b5906480f7246a432c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui record start|note|undo|use|status|cancel|stop` ([#63](https://github.com/delacournz/warden/issues/63)): every `warden ui` action and query is journalled under `$WARDEN_HOME/ui/<udid>/`, and `stop` writes a typed `@delacour/warden-e2e` spec (or an exported helper) directly, then runs it once on the leased device (`--no-verify` skips). The journal is kept until a passing `stop` or a `cancel`, so you can `undo`, fix and `stop` again.
  - `record use` runs an exported helper on the device, then records an import and a call to it.
  - Generated specs use durable selectors only (testID > role+label > text); `snapshot -i` marks elements without one as `[no-id]`. Lints: `coords_target`, `text_only_selector`, `ambiguous_selector`, `unverified_navigation`, `empty_recording`.
  - Secrets typed through `WARDEN_UI_SECRET_<NAME>` never land in the spec; testIDs are merged into an ids module; `wait` / `is` / `get` become auto-waiting expects; `app.open({ wait: "quiet" })`.
  - Recordings reuse the suite's shared `test.use` options and emit `launch: "none"` when the recording or its helper opens the app itself.
  - `stop` prints the `specs.<id>` entries for `warden.config.ts` from the routes seen on a dev client (helper routes merged); it never edits the config.

### Patch Changes

- Updated dependencies []:
  - @delacour/warden-e2e@0.3.0

## 0.2.0

### Minor Changes

- [#58](https://github.com/delacournz/warden/pull/58) [`03136f3`](https://github.com/delacournz/warden/commit/03136f3b414cfce9849183b7b522ffc52086d677) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden-simd` links idb v1.7.7, whose typed bridge answers replace the generic frame decode: the helper's CPU per accessibility read drops by about three quarters (host 9.12 → 3.79 CPU-seconds per bench rep on EAS `macos-large` with the equivalent patch), memory unchanged. A guest that stops answering now surfaces as `E_TIMEOUT` with the seconds allowed.
  - `WARDEN_SIMD_TIMEOUT` (a duration, e.g. `60s`) sets the per-request timeout of the helper client `warden ui` and the e2e runner connect with; the default stays 10 s.
  - `warden e2e` / `warden dev` honour the core `eas: false` opt-out and never call eas-cli when it is set.
  - Golden settle probe works without a GUI launchd session (hosted workers, ssh).

### Patch Changes

- [#69](https://github.com/delacournz/warden/pull/69) [`1d39a21`](https://github.com/delacournz/warden/commit/1d39a21a0f24e3cef6c44130f8d948c3250d1620) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `typeText` with characters the HID keyboard cannot type (`café`, emoji, CJK) pastes the right text again on Xcode 27.1: the simulator pasteboard is written through `devicectl device pasteboard copy` (falling back to `simctl pbcopy`) and confirmed with `pbpaste` before the paste keystroke. `simctl pbcopy` exits 0 there without changing the pasteboard, so the field used to receive whatever the Mac had copied last. An unconfirmed write is now `E_IO` and nothing is pasted.
- Updated dependencies []:
  - @delacour/warden-e2e@0.2.0

## 0.1.2

### Patch Changes

- [#64](https://github.com/delacournz/warden/pull/64) [`2569b9c`](https://github.com/delacournz/warden/commit/2569b9cf7cbadc24b9ca0830233d420f78d1e6ba) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Releases now flow through a changesets "Version Packages" PR into `develop`; merging it fast-forwards `main`, which deploys the docs and publishes the npm packages together.
- Updated dependencies []:
  - @delacour/warden-e2e@0.1.2
