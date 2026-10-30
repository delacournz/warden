This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## This app: `@delacour/warden-example`

A demo app for dogfooding warden end to end: Expo SDK 57 + Expo Router + Uniwind + [Delacour UI](https://ui.delacour.co.nz) components, tested with `@delacour/warden-e2e` (`bun test` specs) and run through `warden e2e`.

- Bundle id / package: `nz.co.delacour.warden.example`, scheme `warden-example`, Metro port `8095`.
- `src/components/ui`, `src/lib`, `src/hooks`, `src/styles` are copied in by `bunx delacour@latest add … --ref main`. Biome skips them, so they stay byte-identical to the registry. Check with `bunx delacour@latest diff --ref main`, and update with `add <name> --ref main --overwrite`.
- State is in-memory (`src/modules/*/contexts`), so every launch starts signed out with the seeded todos (`welcome`, `warden`). The specs depend on that.
- `EXPO_PUBLIC_E2E=1` (baked into the warden Release build) sets `DelacourProvider isMotionCalm`.

### Screens

| Route | What | testIDs |
|---|---|---|
| `/welcome` | 3-step onboarding (`Steps`) | `welcome-*` |
| `/sign-in` | `Field` + `Input` validation. `locked@example.com` gives a form `Alert` | `sign-in-*` |
| `/(tabs)/todos` | add, toggle, filter (`Tabs`), empty state, remaining `Badge` | `todo-*`, `todos-*` |
| `/todo/[id]` | detail `Card`, toggle and delete. Deep link `warden-example://todo/<id>` | `todo-detail-*` |
| `/(tabs)/settings` | `Avatar`, `Switch`es (dark mode via `Uniwind.setTheme`), gesture playground row, sign out | `settings-*` |
| `/gestures` | pinch / two-finger rotate + pan canvas, one-finger trace pad, readouts committed on gesture end, Reset. Deep link `warden-example://gestures`. Rotation is degrees, clockwise positive | `gestures-*` |
| `/conditions` | NetInfo state + offline banner, `Fetch` (HTTPS GET, 8 s timeout, one retry after 3 s with the same `Idempotency-Key`), live `expo-location` coordinates with a 150 m geofence (`Inside` / `Outside`, last `Entered` / `Exited`) and permission state, wall clock + 14-day trial (`Active` / `Expired`) with a Refresh button. Deep link `warden-example://conditions`. No sign-in gate | `conditions-*` |
| `/biometrics` | vault on the `Showcase` shell: face glyph, `status` / `error` readout, attempt log, Face ID unlock. Deep link `warden-example://biometrics` | `bio-*` |
| `/network` | probes a 1 KB HTTPS download every ~1.5 s: signal glyph, latency strip (24 requests), `Online` / `Slow link` (median > 300 ms) / `Requests failing` / `Offline`, Pause probes. Deep link `warden-example://network` | `net-*` |
| `/location` | live `expo-location` track, 150 m geofence around the first fix, speed / distance / fixes readout, fix log. Deep link `warden-example://location` | `loc-*` |
| `/clock` | 14-day trial dial driven by `Date.now()`, clock-jump log. Deep link `warden-example://clock` | `clk-*` |

### e2e

Specs are `bun test` specs driven by `@delacour/warden-e2e`; `warden e2e` leases the sims, installs the build and runs them.

- Specs are `e2e/*.e2e.ts`; helpers are in `e2e/helpers` (`ids.ts` mirrors the testIDs).
- Use `test` and `expect` from `@delacour/warden-e2e`: `test("…", async ({ app, device, screen }) => …)`. Specs are deterministic: queries (`screen.getByTestId/ByText/ByRole/…`), actions (`tap`, `fill`, `press`, `swipe`) and polling assertions (`expect(locator).toBeVisible/toHaveText/toBeChecked/toHaveCount/…`, 5 s default, `{ timeout }` to override). There is no `agent.*`.
- Every spec file starts with `test.use(SPEC_OPTIONS)` (`e2e/helpers/steps.ts`: `launch: "none"`, `systemAlerts: "dismiss"`). The spec opens the app fresh itself, so specs start signed out on the welcome screen: start one with `launch` / `openSignIn` / `signedIn`, which call `app.open({ wait: "quiet" })` (in front and still) and wait for the first screen. `systemAlerts: "dismiss"` clears a system prompt left over from a previous run wherever a read, tap or assertion meets one. After submitting sign-in, `expectTodosAfterSignIn` waits for the todos screen.
- The first Next press on the welcome screen goes through `nextStep` (`tap({ until })` on the step title): the button is in the AX tree before it takes touches (replace animation into `/welcome`, RNGH handler attaches after mount) and a HID tap has no ack, so a dropped press is re-sent (4 s a press, two re-sends). Same family as the first tab and row presses after sign-in: `tap({ until: <the screen it opens> })`.
- Deep links: `device.openLink(url)` answers iOS's "Open in warden-example?" sheet itself; `openDeepLink` opens it again (3 links, 6 s each) when the target screen did not show.
- `Badge` / `Chip` text: assert on the container (`expect(locator).toHaveText("2 left")`); `locator.text()` falls back to the descendant text when iOS leaves the container's own label empty.
- `warden.config.ts` defines:
  - project `example`: build kinds. `simulator` (the default of `warden e2e`) is a Release build with no JS embedded, built once per native fingerprint, and this worktree's JS (`EXPO_PUBLIC_E2E=1` baked in) is repacked into it in seconds (`warden repack ios`); `dev` is the Debug dev client; variant `bench` is the benchmark's Release build with the JS embedded;
  - suite `example`: 2 sims, install (skipped when the sim already has this build; no uninstall, state is in-memory), slim, and the spec → screen `entries` that `warden affected` uses. `--dev` runs the same suite on the dev client: warden starts and verifies its own Metro (the suite's `metro`, which also sets `--initialUrl` and turns the Expo dev menu off), and one spec process per device runs its share of the specs (the default `isolate: "device"`). `metro` applies only with `--dev`;
  - `spec.bundleId` is the app the specs drive (`app.open()` launches it with `WARDEN_LAUNCH_ARGS`).

The network / location / clock specs (`network-*`, `location-*`, `clock-*`) run in the `conditions` suite (`warden e2e conditions`), not `example`: it declares `conditions.network: "online"`, so on iOS every launch carries the network dylib and a spec can change network or clock mid-test. `warden e2e conditions` needs the dylib built (`packages/e2e/native/dist/libwarden-inject.dylib`).

```bash
bun run e2e --all                    # warden e2e example (this checkout's warden); drop --all for the specs this branch needs
bun run e2e:dev -- --all             # warden e2e example --dev: dev client + warden's Metro
bun run e2e:affected -- --explain    # which specs this branch needs
bun run e2e:spec todos               # one spec
WARDEN_UDID=<udid> WARDEN_BUNDLE_ID=nz.co.delacour.warden.example bun test --preload @delacour/warden-e2e/preload e2e/todos.e2e.ts   # by hand, on an installed build
```

Never start Metro or export device env vars for a suite: `warden e2e <suite>` does both. By hand, the build must already be installed on the sim (`WARDEN_UDID`); add `WARDEN_PLATFORM=android` for an emulator and `WARDEN_METRO_URL` for a dev client.

Failure output is written per test under `<batchDir>/e2e/<worker>-<seq>/<spec>/<title>-<hash>/` (`failure.png`, `screen-at-failure.txt`, `trace.jsonl`, `console.jsonl` / `network.jsonl` with a dev client) and indexed in `results.jsonl`; `warden e2e` prints the path of each failing spec. `screen-at-failure.txt` is the full accessibility tree, so read it first.

### Accessibility

Specs read the accessibility (AX) tree, not the React tree: a `testID` is only exposed when the view is `accessible`. Mark every view a spec taps or asserts `accessible` (add `accessibilityLabel` / `role` where it helps), and keep switches and checkboxes real controls so `toBeChecked` reads their state. When a `testID` query finds nothing, compare against `screen-at-failure.txt` before adding retries or waits. To look yourself, run `warden ui snapshot -i --udid <udid>` on the leased sim: a tap target missing there is not `accessible` or has no `testID`; `warden ui tree` shows the React side. Fix it in the component (mark it `accessible`), not in the spec.

### Simulator-only crash and sheets

- `react-native-pulsar` (haptics) is patched (`patches/react-native-pulsar@1.7.0.patch`, a root `patchedDependencies` entry): on `TARGET_OS_SIMULATOR` its native module no longer creates the `Pulsar` object. That object starts an AVAudioEngine whose AURemoteIO RPC times out at random on a simulator, aborting the app (SIGABRT on thread `com.pulsar.audio`, crash reports `wardenexample-*.ips`) and sending a running spec back to the welcome screen. JS needs no gate: every call is a no-op on a simulator, which has no haptics anyway. A real device is unaffected. Gating the JS `import` alone does not help, the native module starts at launch. Drop the patch when upstream (software-mansion/pulsar) stops starting the engine on a simulator. Changing it changes the native fingerprint, so the next `warden e2e` rebuilds.
- The sign-in fields opt out of iOS credential AutoFill in e2e builds (`NO_AUTOFILL` in `src/app/sign-in.tsx`: `autoComplete="off"`, `textContentType="oneTimeCode"`; `EXPO_PUBLIC_E2E=1`). Without it iOS raised a "Save Password?" sheet (hosted by SafariViewService, cold-launched) anywhere from 1 to 6 s after sign-in. A spec that typed meanwhile (`fill(todo-input)`) sent its keys to no focused field and the dev client reloaded its JS, back to the welcome screen: the dev-client (`--dev`) `todos` flake (about 40% of runs, never on Release). Do not remove it, and do not wait for the sheet: it is gone.
- Android: `NO_AUTOFILL` also sets `importantForAutofill: "no"` (RN `TextInput`, documented values `auto|no|noExcludeDescendants|yes|yesExcludeDescendants`). Without it Google Password Manager raised a "Save password to Google Password Manager?" sheet (`autofill_save`) over the app after a valid sign-in on a real Android 14 phone, and `todos-screen` never became visible. The specs' `systemAlerts: "dismiss"` is the backstop: warden closes that sheet with Back and never taps Never / Continue (both write to the user's Google account).
