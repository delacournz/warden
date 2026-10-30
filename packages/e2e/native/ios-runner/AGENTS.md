# warden-runner (iOS devices, XCUITest)

The real-device twin of `warden-simd` (WDN-PHY-3). A UI-test bundle that listens on TCP and speaks the `warden-simd`
NDJSON protocol (`driver/ios/simd-protocol.ts`), so the TS side reuses its schemas. Public XCUITest API only.

| Path | What |
|------|------|
| `RunnerCore/` | SwiftPM, no XCTest: request validation (`Command.swift`), element type -> role, landscape -> portrait-up (`FrameSpace.swift`), usage id -> key (`KeyMap.swift`), snapshot encoder, error classifier, NDJSON/TCP server. `swift test --package-path packages/e2e/native/ios-runner/RunnerCore` |
| `RunnerCore/Sources/RunnerCore/Shared/` | symlinks to `warden-simd`'s `Wire.swift`, `NDJSON.swift`, `Element.swift`, `RoleMap.swift`; edit the originals |
| `RunnerTests/` | XCTest glue: `RunnerTests.testServe` (the process that lives), `XCUIExecutor` (op map), `ElementTypeName` |
| `Host/` | empty SwiftUI app the UI-test bundle is hosted by |
| `project.yml` -> `WardenRunner.xcodeproj` | generated, checked in. After adding/removing a Swift file or editing `project.yml`: `cd packages/e2e/native/ios-runner && xcodegen generate` (`brew install xcodegen`). `native/scripts/runner-project.test.ts` fails on drift |

- A failed XCUITest call is not survivable: a recorded issue ends `testServe` shortly after, even with `continueAfterFailure = true` (seen on device: typing with no keyboard focus). So the executor checks preconditions first (`requireKeyboardFocus` -> `E_NO_ELEMENT`) and runs every op through `WardenCatch` (ObjC `@try`, `RunnerTests/ObjCCatch.m`) as a backstop. Add a precondition check for any new op that can record an issue.
- Anything that needs no device belongs in `RunnerCore` with a test; `XCUIExecutor` only calls XCUITest.
- Goldens: `RunnerCore/Tests/RunnerCoreTests/Fixtures/*.golden.json` (`WARDEN_RUNNER_UPDATE_GOLDEN=1 swift test ...` rewrites), also parsed by the zod schemas in `native/scripts/element-shape.test.ts`.
- Signing: `DEVELOPMENT_TEAM` comes from the environment or the command line, never the project. Bundle ids derive from one setting, `WARDEN_RUNNER_BUNDLE_ID` (default `nz.co.delacour.warden.runner.$(DEVELOPMENT_TEAM:lower)`, UI-test bundle `<id>.uitests`, runner app `<id>.uitests.xctrunner`). Override that setting, not `PRODUCT_BUNDLE_IDENTIFIER` (it would give both targets one id).
- Runtime env (`TEST_RUNNER_<NAME>` on the `xcodebuild` command line or in the `.xctestrun`): `WARDEN_RUNNER_PORT` (0/unset = free port), `WARDEN_RUNNER_UDID`, `WARDEN_RUNNER_IDLE_SECONDS` (default 3600, 0 = never). stdout carries `WARDEN_RUNNER_READY {ready event json}`; each connection also gets the `ready` event first.
- Not in the runner (`E_UNSUPPORTED`): pinch, rotate, `gesture`, shake, lock/side/siri/applePay, `paste`, `selectAll`, `settle`, `rebind`, `elementAtPoint`, `orientation{set}` (devicectl does it; `XCUIDevice.orientation = x` does not rotate the UI).
- Extras on the wire vs simd: ops take an optional `bundleId` (default: the last launched app, else SpringBoard); `snapshot` accepts `backend:"axbridge"` and answers `fallback`; `launch` answers `pid: 0` (XCUITest exposes none); `appState{bundleId}`; `screenshot` always answers `png` (`path` is ignored, the phone's disk is not the Mac's).
- By hand on a phone: `DEVELOPMENT_TEAM=<id> bun native/scripts/runner-smoke.ts --udid <udid>` (unlocked, paired; uninstalls its bundles afterwards).
