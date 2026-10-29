# Warden viewer

> `@delacour/warden-viewer`: Tauri v2 desktop app that shows and drives ONE hosted iOS/Android device from warden cloud. `warden view` (apps/cli) spawns it. Private and non-shipping from npm; the CLI downloads the built binary. Targets: macOS (arm64, x64) and Windows. Linux is not supported (WebKitGTK WebRTC is off): the app prints an error event and exits 1.

## Stack

Tauri v2, Vite, React 19, TanStack Router (file routes, `__root` + `index`), Tailwind v4, `@delacournz/apogee` (optionalDependency, needs `NPM_TOKEN`; without it typecheck and build fail here only), Phosphor icons, Rust (`reqwest` with rustls). Tests: `bun test` (TS), `cargo test` (Rust).

## Process contract (the CLI implements the other side; keep it exact)

- Launch: the binary with no args. Nothing secret on argv or env.
- stdin, JSON lines:
  - First: `{"apiUrl","deviceId","token":"wvt_…","expiresAt","scope":"view"|"drive","title","platform":"ios"|"android","detached":boolean}`
  - Later: `{"token","expiresAt"}` replaces the token in memory.
  - EOF with `detached:false`: the parent died; close the window, exit 0.
  - EOF with `detached:true`: keep the held token and the window. When `expiresAt` passes, Rust emits `viewer-expired`; the window drops the stream and shows "Access expired, run warden view again". Exit 0 when the user closes the window.
- stdout, JSON lines only: `{"event":"ready"}` (window up), `{"event":"streaming"}` (first frame, once), `{"event":"error","message"}` (fatal). Logs go to stderr.
- Exit: 0 on window close or stdin EOF, 1 on a fatal startup error (bad first line, unsupported OS).

## Architecture

Rust owns the token. The webview makes no network requests (CSP has no remote `connect-src`) and never sees the token.

- `src-tauri/src/session.rs`: stdin parsing, `SessionState` (RwLock), refresh pump, stdout events.
- `src-tauri/src/device.rs`: `#[tauri::command]`s. `viewer_info` (no token), `whep_offer`/`whep_candidate`/`whep_close` (Location kept in Rust; refused if on another origin), `tap`/`swipe`/`input`/`open_url` (refused locally for `view` scope), `screenshot` (save panel, PNG written in Rust), `viewer_streaming`, `fit_window`. Errors serialise as `{code, message}`.
- Capabilities: `core:default`, `dialog:default`, `log:default`, `core:window:allow-set-always-on-top`.
- `src/core/api/device.api.ts`: `invoke` wrappers (`DeviceError` carries `code`).
- `src/modules/stream/`: `whep.ts` (pure: backoff, trickle-ICE fragment), `whep-session.ts` (RTCPeerConnection recvonly, reconnect on failed/disconnected), `use-whep.ts`, `viewer.tsx` (window layout).
- `src/modules/input/`: `input.ts` pure mapping (letterbox-aware `toDevicePoint`, tap/swipe classifier, wheel accumulator, key batcher), `use-device-input.ts` wires it to the DOM. No input at all in `view` scope or watch mode.
- `src/modules/toolbar/`: apogee toolbar (open URL, screenshot, watch/drive toggle for `drive` scope, always-on-top, status badge).

## Commands

```bash
bun run dev            # tauri dev (Vite :3231 + Rust); feed the stdin JSON by hand
bun run build:frontend # tsc + vite build
bun run tauri:build -- --debug --bundles app   # macOS bundle
bun test               # TS unit tests
bun run test:rust      # cargo test
bun run typecheck && bun run check
```

Smoke: `echo '{"apiUrl":"http://127.0.0.1:9","deviceId":"d1","token":"wvt_x","expiresAt":"2030-01-01T00:00:00Z","scope":"drive","title":"t","platform":"ios"}' | "<bundle>/Contents/MacOS/warden-viewer"` prints `{"event":"ready"}`; closing stdin exits 0.

## Release

`release.yml`'s `viewer` job (matrix: `darwin-arm64`, `darwin-x64` cross-compiled on the Mac runner, `win32-x64` on `windows-latest`) runs `tauri build`, `bun run pack:asset <target>` (writes `dist-assets/warden-viewer-<target>.tgz` with `warden viewer.app/` or `warden-viewer.exe` at the archive root, via `tar` so the exec bit and symlinks survive) and uploads it. `publish` merges the three sha256 lines into the release's `SHA256SUMS` and attaches the tarballs. The CLI downloads them for tag `v<version>`.

Secrets (repo, or the `release` environment the job runs in). All signing ones are optional: missing, the build is unsigned and a `::warning::` is printed.

| Secret | What |
|---|---|
| `NPM_READ_TOKEN` | classic PAT with `read:packages`, installs `@delacournz/apogee` (required) |
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect API issuer id |
| `APPLE_API_KEY` | App Store Connect API key id |
| `APPLE_API_KEY_CONTENT` | the `.p8` key file's content (written to a temp file, passed to Tauri as `APPLE_API_KEY_PATH`) |
| `WINDOWS_CERTIFICATE` | optional, base64 of an Authenticode `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | optional, the `.pfx` password |

All six `APPLE_*` must be set for macOS signing; otherwise none is used. Signed builds use the hardened runtime and are notarized and stapled by Tauri. There is no entitlements file on purpose: the viewer only receives WebRTC video in WKWebView, needs no camera or microphone, and is not sandboxed. Do not enable the App Sandbox. Windows builds a bare exe (`--no-bundle`); the `windows_subsystem = "windows"` GUI process still reads the parent's piped stdin/stdout.

Local pack: `bun run tauri:build -- --bundles app && bun run pack:asset darwin-arm64` (add `--profile debug` after a debug build).

## Rules

- TDD: pure logic gets a failing `*.test.ts` first; Rust pure bits get `#[cfg(test)]` tests.
- The token never crosses `invoke` toward JS, and never goes to argv, env, logs or the DOM.
- No `any`, no barrel exports, no comments inside JSX, no new plugins or capabilities without a reason.
- `routeTree.gen.ts` is generated by the Vite plugin and committed.
