---
"@delacour/warden": minor
---

- `warden dev` (and every command that finds the project) works from a monorepo root without a `warden.config.ts`: when nothing is found upwards it looks below, in the package.json `workspaces` (else `apps/*` and `packages/*`). One app there is used and named; with several, `warden dev` asks which one, and a pipe gets the list and `--project <dir>`.
- `warden dev` runs bare React Native apps. An app whose package.json depends on `react-native` but not `expo` gets its bundle ids from `ios/*.xcodeproj` and `android/app/build.gradle`, Metro as `react-native start` on the leased port, `react-native build-ios` / `build-android` as the default local build, and is relaunched against Metro (`-RCT_jsLocation` on iOS, port 8081 reversed on Android). No `expo-dev-client` is asked for. `c` restarts Metro with `--reset-cache`.
- New `projects[].framework` (`"expo"` | `"react-native"`) in `warden.config.ts` overrides the guess from package.json.
