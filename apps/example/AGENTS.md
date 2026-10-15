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
- State is in-memory (`src/modules/*/contexts`), so every launch starts signed out with the seeded todos (`welcome`, `warden`). The flows depend on that.
- `EXPO_PUBLIC_E2E=1` (baked into the warden Release build) sets `DelacourProvider isMotionCalm`.

### Screens

| Route | What | testIDs |
|---|---|---|
| `/welcome` | 3-step onboarding (`Steps`) | `welcome-*` |
| `/sign-in` | `Field` + `Input` validation. `locked@example.com` gives a form `Alert` | `sign-in-*` |
| `/(tabs)/todos` | add, toggle, filter (`Tabs`), empty state, remaining `Badge` | `todo-*`, `todos-*` |
| `/todo/[id]` | detail `Card`, toggle and delete. Deep link `warden-example://todo/<id>` | `todo-detail-*` |
| `/(tabs)/settings` | `Avatar`, `Switch`es (dark mode via `Uniwind.setTheme`), sign out | `settings-*` |

### e2e

Flows are `bun test` specs driven by `@delacour/warden-e2e`; `warden e2e` leases the sims, installs the build and runs them.

- Flows are `e2e/*.e2e.ts`; helpers are in `e2e/helpers` (`ids.ts` mirrors the testIDs).
- Use `test` and `expect` from `@delacour/warden-e2e`: `test("…", async ({ app, device, screen }) => …)`. Flows are deterministic: queries (`screen.getByTestId/ByText/ByRole/…`), actions (`tap`, `fill`, `press`, `swipe`) and polling assertions (`expect(locator).toBeVisible/toHaveText/toBeChecked/toHaveCount/…`, 5 s default, `{ timeout }` to override). There is no `agent.*`.
- The runner opens the app fresh before every test (`app.open()`, `launch: "fresh"`), so flows start signed out on the welcome screen. Start one with `launch` / `openSignIn` / `signedIn` from `e2e/helpers/flows.ts`: they dismiss a system prompt left over from a previous run (`device.alert("dismiss")`) and wait for the first screen. After submitting sign-in, `expectTodosAfterSignIn` keeps dismissing Keychain's "Save Password?" sheet until the todos screen shows.
- Deep links: `device.openLink(url)` answers iOS's "Open in warden-example?" sheet itself.
- `Badge` / `Chip` text: assert on the container (`expect(locator).toHaveText("2 left")`); `locator.text()` falls back to the descendant text when iOS leaves the container's own label empty.
- `warden.config.ts` defines:
  - project `example`: a Release build keyed on native + JS;
  - variant `dev`: the Debug dev client, keyed on native only;
  - suite `example`: 2 sims, install (skipped when the sim already has this build; no uninstall, state is in-memory), slim, and the flow → screen `entries` that `warden affected` uses;
  - suite `example-dev`: the same flows on the dev client. warden starts and verifies its own Metro (`metro`, which also sets `--initialUrl` and turns the Expo dev menu off), and one spec process per device runs its share of the flows (`mode: "single"`);
  - both suites set `spec.bundleId`, the app the specs drive (`app.open()` launches it with `WARDEN_LAUNCH_ARGS`).

```bash
bun run e2e --all                    # warden e2e example (this checkout's warden); drop --all for the flows this branch needs
bun run e2e:dev -- --all             # warden e2e example-dev: dev client + warden's Metro
bun run e2e:affected -- --explain    # which flows this branch needs
bun run e2e:flow todos               # one flow
WARDEN_UDID=<udid> WARDEN_BUNDLE_ID=nz.co.delacour.warden.example bun test e2e/todos.e2e.ts   # by hand, on an installed build
```

Never start Metro or export device env vars for a suite: `warden e2e <suite>` does both. By hand, the build must already be installed on the sim (`WARDEN_UDID`); add `WARDEN_PLATFORM=android` for an emulator and `WARDEN_METRO_URL` for a dev client.

Failure output is written per test under `<batchDir>/e2e/<worker>-<seq>/<flow>/<title>-<hash>/` (`failure.png`, `screen-at-failure.txt`, `trace.jsonl`, `console.jsonl` / `network.jsonl` with a dev client) and indexed in `results.jsonl`; `warden e2e` prints the path of each failing flow. `screen-at-failure.txt` is the full accessibility tree, so read it first.

### Accessibility

Flows read the accessibility (AX) tree, not the React tree: a `testID` is only exposed when the view is `accessible`. Mark every view a flow taps or asserts `accessible` (add `accessibilityLabel` / `role` where it helps), and keep switches and checkboxes real controls so `toBeChecked` reads their state. When a `testID` query finds nothing, compare against `screen-at-failure.txt` before adding retries or waits.
