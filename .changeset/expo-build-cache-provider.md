---
"@delacour/warden": minor
---

- New `@delacour/warden/expo-build-cache`: set `buildCacheProvider: { plugin: "@delacour/warden/expo-build-cache" }` in the app config and plain `expo run:ios` (Debug, simulator) reuses the dev build in warden's cache instead of running `xcodebuild`, and files its own build there after a miss. Projects with a variant, a custom build command or `native+js` fingerprinting, Release runs, device runs and Android are left to Expo
- New `warden builds path <ios|android> [--kind dev] [--hash <fp>] [--json]` prints where the cached dev build is without building or downloading anything; exit 2 when nothing is cached
- `warden builds import <App.app> --kind dev [--hash <fp>[:dev]]` files a Debug simulator `.app` as the project's dev build, the one `warden dev` and `warden app ensure --kind dev` share
