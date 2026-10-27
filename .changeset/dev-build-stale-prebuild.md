---
"@delacour/warden": patch
---

- `warden dev`, `warden app ensure` and `warden run --app` no longer cache a dev build made from a stale git-ignored `ios/` / `android/` dir. When the native fingerprint has changed since that dir was prebuilt (a new native dependency such as `expo-application`), or warden does not know which fingerprint it was prebuilt for, the local build removes it first so `expo prebuild` and `pod install` run again. Before, the build skipped both and linked none of the new native modules, so the dev client crashed with `Cannot find native module '<X>'`. A committed native dir, and a custom `build` command that does not run `expo prebuild` / `expo run:*`, are left as they are.
