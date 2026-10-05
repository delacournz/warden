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

A demo app for dogfooding warden end to end: Expo SDK 57 + Expo Router + Uniwind + [Delacour UI](https://ui.delacour.co.nz) components, tested with [tester.army e2e](https://e2e.tester.army/docs/mobile) and run through `warden e2e`.

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

- Flows are `e2e/*.e2e.ts`; helpers are in `e2e/helpers` (`ids.ts` mirrors the testIDs).
- Use `test` from `@e2e-dev/mobile` and `expect` from `e2e`. Flows must be deterministic, so never use `agent.*`.
- Start a flow with `launch` / `openSignIn` / `signedIn` from `e2e/helpers/flows.ts`, not a bare `app.open()`. They clear iOS prompts that cover the app: the "Open in warden-example?" prompt left by a deep link (it outlives a reinstall), and Keychain's "Save Password?" sheet after sign-in.
- `e2e.config.ts` pins the device from `WARDEN_UDID` (or `E2E_UDID`), with one agent-device session per device.
- `warden.config.ts` defines:
  - project `example`: a Release build keyed on native + JS;
  - suite `example`: 2 sims, clean install, slim, and the flow → screen `entries` that `warden affected` uses.

```bash
bun run e2e                          # warden e2e example (this checkout's warden)
bun run e2e:affected -- --explain    # which flows this branch needs
bun run e2e:flow todos               # one flow
E2E_UDID=<udid> bunx e2e run e2e/todos.e2e.ts   # by hand, on an installed build
```

Failure output is in `.e2e/<worker>-<seq>/` (`report.json`, `artifacts/`) and in warden's batch logs and screenshots.
