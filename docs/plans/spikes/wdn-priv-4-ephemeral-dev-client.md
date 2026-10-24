# WDN-PRIV-4 spike: ephemeral expo-dev-client (shadow build)

Date 2026-10-22 · Verdict: **GO, no Metro wrapper needed.**

## Question
Can warden give an Expo app without `expo-dev-client` a dev-client experience with zero changes to the user's checkout?

## Result
Yes. A dev client built in an APFS-cloned shadow connects to, loads and runs a bundle served by Metro started from the real checkout whose `node_modules` has NO `expo-dev-client`. The `--config` metro wrapper (`resolver.extraNodeModules`) was not needed and was not tried.

Why it works: the dev launcher + dev menu are native (their JS UI is embedded in the native pods). The app entry (`expo-router/entry`) never imports `expo-dev-client`; Metro only needs to serve the app's own JS. `expo start --dev-client` only warns ("Unable to determine the default URI scheme ... Ensure expo-dev-client is installed") because it cannot read the scheme. Nothing else broke.

Verified with `warden ui snapshot -i`: app rendered `welcome-screen` (first route of the example), dev menu showed "Connected to: http://127.0.0.1:8091". Metro log: `iOS Bundled 9281ms index.ts (4498 modules)`.

## Test subject
Copy of `apps/example` (src, assets, config; warden workspace deps and scripts stripped; `expo-dev-client` removed from package.json, the app.config.ts plugin entry and node_modules), standalone `bun install` (8.6 s, 599 pkgs). SDK 57, RN 0.86.3. Layout: `real/` (user checkout), `shadow/`, `dd/` (DerivedData).

## Exact commands (all verified)
```sh
cp -c -R real shadow                                  # APFS clone, 557 MB incl node_modules
cd shadow && bunx expo install expo-dev-client        # 57.0.20
bunx expo prebuild --platform ios --no-install
(cd ios && pod install)
xcodebuild -workspace wardenexample.xcworkspace -scheme wardenexample -configuration Debug \
  -destination 'id=<udid>' -derivedDataPath <dd> build
xcrun simctl install <udid> <dd>/Build/Products/Debug-iphonesimulator/wardenexample.app
# Metro from the REAL checkout, leased port
cd real && EXPO_NO_TELEMETRY=1 bunx expo start --dev-client --port <leased>
# same launch warden dev uses (devClientLaunchArgv)
xcrun simctl launch --terminate-running-process <udid> <bundleId> --initialUrl http://127.0.0.1:<port>
```

## Timings (M-series, shared machine, cold ccache state not controlled)
| step | time |
|---|---|
| `cp -c -R` checkout+node_modules (557 MB) | 9.7 s |
| `bunx expo install expo-dev-client` | 1.4 s |
| `expo prebuild --no-install` | 1.9 s |
| `pod install` | 25 s |
| `xcodebuild` Debug sim (cold DerivedData) | 297 s |
| total shadow -> installable .app | ~335 s |
| Metro first bundle (4498 modules) | 9.3 s |
| `@expo/fingerprint` real / shadow | 3.4 s / 7.2 s |

## Fingerprint / cache key
- Real and shadow fingerprints differ (`feb8cba4...` vs `3b2ebd78...`): the shadow has `expo-dev-client` in package.json/autolinking and a generated `ios/`.
- So the cache key must be computed from the **real** checkout (cheap, no shadow needed on a hit) and salted: `key = hash(realNativeFp + "+ephemeral-dev-client@" + devClientVersion)`. Check the cache/installed tier BEFORE cloning; only clone on a miss. This also makes hits work across worktrees as today.
- Salt should also include the resolved SDK (the `expo install` version is SDK-pinned, so `expo` version in the real fp already covers it, but record the installed dev-client version for the salt).
- Fingerprint drift risk: the real native fp does not see the shadow's added native module; the salt version covers it.

## Gotchas
1. `expo install expo-dev-client` does NOT add the config plugin; autolinking is enough for the launcher (the example's `launchMode: "most-recent"` plugin option is unavailable). Default launcher shows the picker unless `--initialUrl` is passed, which `warden dev` already does on iOS.
2. Android `warden dev` resolves the scheme via expo-dev-client (`lazyScheme`); on the real checkout it will fail ("Unable to determine the default URI scheme"). Read `scheme` from the expo config (`expo config --json`) for ephemeral mode. Not tested here (iOS only).
3. `dev.ts` `preflight` (line ~287) refuses without `expo-dev-client`; change to route to the shadow path. Metro args still `--dev-client`.
4. Metro from the real checkout writes `.expo/` and `expo-env.d.ts` there (same as any `expo start`; normally gitignored in Expo apps). Not warden-specific; document it. `CI=1` disables reload/watch (I set it to run headless; warden normally does not).
5. APFS clone does the work: 9.7 s mostly inode creation for ~100k files. Exclude `ios/`, `android/`, `.expo`, `.git` from the clone; `.git` is large and unneeded (fingerprint tooling in the shadow ran fine without git).
6. Monorepos: workspace deps hoisted above the app root are not under the checkout dir; the clone must root at the workspace root (or the app's `node_modules` symlinks break). Not tested; flag as risk. Prefer cloning the git-root/workspace-root minus `.git`.
7. Absolute shadow paths get baked into the .app's Pods debug info and `Bundle React Native` phase env; harmless in Debug (JS not embedded) but do not delete the shadow dir while debugging native stack traces.
8. SDK 57 uses prebuilt RN (`React-Core-prebuilt`, `ReactNativeDependencies`) automatically; the 297 s was mostly Pods + app compile.
9. Real `package.json` untouched and no dev-client in real `node_modules` confirmed after the run (`ls real/node_modules | grep -c dev-client` = 0).
10. JS-only edits are served by the real checkout's Metro, so Fast Refresh/reload is the real source (not tested with CI unset).

## Recommended PRIV-4 implementation
1. `ephemeral-dev-client.ts` in core/builds: `shadowDir(wardenHome, projectKey, key)` = `<home>/shadow/<project-key>/<key>/`; `ephemeralKey(realFp, devClientVersion)`.
2. In `ensureApp`: if `expo-dev-client` missing and (default or `--ephemeral-dev-client`), compute real fp + salt, look up installed/shared cache first; on miss: lock (existing `lock.ts`), `cp -c -R` root minus `.git`/`ios`/`android`/`.expo`, `expo install expo-dev-client` (use the project's package manager: detect lockfile; bun shown), prebuild, pod install, build with the shared compiler cache env, store the .app under the salted key. Delete the shadow after a successful build (keep only on `--keep-shadow`) to save disk; incremental rebuilds can reuse it if kept.
3. `dev.ts`: relax `preflight`, keep Metro `--dev-client` from the real root, scheme from `expo config`; print `note: using ephemeral expo-dev-client (shadow build)`.
4. `warden gc` / `builds prune`: remove shadow dirs older than N days or with no lock holder.
5. Fallback `--plain-debug` is not needed on this evidence; keep only if a project fails prebuild (custom native dirs committed: if the repo already has `ios/`, clone it and skip prebuild, but still run pod install after the autolinking change).
6. Tests: shadow path, salt, repo tree unchanged (snapshot dir listing), prune.

## Not covered
Android, monorepo with hoisted node_modules, repos with committed `ios/`, warm-cache build time, EAS-built dev clients.
