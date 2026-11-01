# Warden viewer

> `@delacour/warden-viewer`: Tauri v2 desktop app that shows and drives hosted iOS/Android devices from warden cloud, one window per device in one app (one dock icon). `warden view` (apps/cli) spawns it. Private and non-shipping from npm; the CLI downloads the built binary. Targets: macOS (arm64, x64) and Windows. Linux is not supported (WebKitGTK WebRTC is off): the app prints an error event and exits 1.

## Stack

Tauri v2, Vite, React 19, TanStack Router (file routes, `__root` + `index`), Tailwind v4, `@delacournz/apogee` (optionalDependency, needs `NPM_TOKEN`; without it typecheck and build fail here only), Phosphor icons, Rust (`reqwest` with rustls, `tauri-plugin-opener`, `webrtc`/`rtc` 0.21 for the native stream). Tests: `bun test` (TS), `cargo test` (Rust).

## Process contract (the CLI implements the other side; keep it exact)

Each CLI spawn is one device's session. The spawned process is a headless **relay** (see Processes); everything below is what the CLI sees from it, unchanged from the one-process-per-device days.

- Launch: the binary with no args. Nothing secret on argv or env.
- stdin, JSON lines:
  - First: `{"apiUrl","deviceId","token":"wvt_…","expiresAt","scope":"view"|"drive","title","platform":"ios"|"android","detached":boolean,"billingUrl"?}`. `billingUrl` is optional, `https://` only, or `http://` on a loopback host for a local dev web app (anything else is dropped with a stderr warning, not fatal) and is opened only by `open_billing`
  - Later: `{"token","expiresAt"}` replaces the token in memory.
  - EOF with `detached:false`: the parent died; close the window, exit 0.
  - EOF with `detached:true`: keep the held token and the window. When `expiresAt` passes, Rust emits `viewer-expired`; the window drops the stream and shows "Access expired, run warden view again". Exit 0 when the user closes the window.
- Polling: Rust calls `GET {apiUrl}/v1/devices/:deviceId` every 15 s with the viewer token. 401 and 404 end polling quietly, other failures are logged and retried.
- Webview events (not on stdout): `viewer-expired` (no payload), `viewer-billing` `{"lowBalance":boolean}` (when `billing.lowBalance` changes), `viewer-stopped` `{"reason":"user"|"idle"|"credits_exhausted"|"error"|"unknown"}` (once, when `status` is `stopped` or `failed`; polling then ends). `credits_exhausted` shows "You've run out of credits" with **Top up**; other reasons show "Device stopped".
- stdout, JSON lines only: `{"event":"ready"}` (window up), `{"event":"streaming"}` (first frame, once), `{"event":"close","release":boolean}` (attached only, the close prompt's choice just before exit 0: `true` = Shut down, the CLI stops the device and releases the lease; `false` = Keep running), `{"event":"error","message"}` (fatal). Logs go to stderr.
- Close: attached and the device still live (no expired/stopped overlay) → the close button and Cmd/Ctrl+W show the in-window prompt (Keep running, focused / Shut down device / Cancel, Esc); otherwise the window just closes. `close_viewer` refuses `release` when detached (`DETACHED`). Ctrl+C on the CLI side also stops and releases.
- Exit: 0 on window close or stdin EOF, 1 on a fatal startup error (bad first line, unsupported OS, no host reachable within 5 s).
- Same device opened again while its window is up: the window is reused (retitled, reloaded, focused) with the new session; the previous relay exits 0.

## Processes (relay and host)

```
CLI ──spawn──▶ warden-viewer (relay: no args, no Tauri, no dock icon)
                 │ stdin/stdout JSON lines (the contract above)
                 ▼ owner-only local socket, JSON frames
               warden-viewer --host (one per install, detached, the only Tauri app)
                 ├─ window dev-<deviceId>: session, WHEP resource, watchers
                 └─ window dev-<deviceId>: …
```

- `--host` is internal: only a relay passes it. Never document it for users or call it from the CLI.
- Relay (`src-tauri/src/relay.rs`): validates the first line, connects to the host or starts it (`setsid` on macOS; `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` on Windows; stdin/stdout null, stderr appended to the endpoint's `.log`), sends `open` / `refresh` / `eof`, prints the host's `ready` / `streaming` / `close` / `error`. Exits 0 on `closed` or a dropped socket after `ready`, 1 on `error` or a drop before `ready`; `closed: shutdown` before `ready` (host exiting) reconnects, up to 3 times.
- Host (`src-tauri/src/host.rs` logic, `lib.rs` Tauri side): no initial window (`tauri.conf.json` `windows: []`); one `dev-<deviceId>` window per `open` (420×900, same chrome). EOF from an attached relay or the relay dropping closes that window only; EOF from a detached one answers `closed: detached` and keeps the window until expiry. Closing a window sends its relay `closed: window`. The host exits 2 s after the last window and relay are gone (10 s after start with no relay); `ExitRequested` without a code is prevented so closing the last window doesn't end it early.
- Frames (`src-tauri/src/ipc.rs`, `proto: 1`): relay→host `{"t":"open","proto":1,"line":"<first stdin line>"}`, `{"t":"refresh","line":"…"}`, `{"t":"eof"}`; host→relay `{"t":"ready"}`, `{"t":"streaming"}`, `{"t":"close","release":boolean}`, `{"t":"closed","reason":"window"|"eof"|"detached"|"superseded"|"shutdown"}`, `{"t":"error","message"}`. 64 KiB max per line; decode errors never quote the line (it may hold the token).
- Endpoint: key `<CARGO_PKG_VERSION>-<fnv1a(exe path) 8 hex>`, so each install and each dev build gets its own host. macOS: `$TMPDIR/warden-viewer/<key>.sock` (dir 0700 and owned by us, or refused; socket 0600; `/tmp/warden-viewer-<uid>/` when the path would pass 100 bytes), peers with another uid are dropped. Windows: `\\.\pipe\warden-viewer-<key>-<user>` with `first_pipe_instance` and `reject_remote_clients`, default pipe ACL.
- Election: a relay that can't connect takes `flock` on `<key>.lock`, re-probes, unlinks a stale socket, spawns the host, then retries the connect with backoff. The host binds under the same lock and exits 0 when another host already answers.
- The token travels only inside `open.line` / `refresh.line` over the owner-only socket: never argv, env or logs.

## Architecture

Rust owns the token. The webview makes no network requests (CSP has no remote `connect-src`) and never sees the token.

- `src-tauri/src/session.rs`: start/refresh line parsing, `SessionState` (RwLock), contract events.
- `src-tauri/src/registry.rs`: `Registry` of `Viewer`s keyed by window label (`dev-<deviceId>`): session, WHEP resource, `streaming` latch, `EventSink` (the relay), and a generation that takeover and close bump so stale watchers stop. One shared `reqwest::Client`.
- `src-tauri/src/billing.rs`: pure parse of the polled `RemoteDevice` (`status`, `stopReason`, `billing.lowBalance`) and the emit/stop decision; the poll thread is `watch_billing` in `lib.rs`, one per window. Webview events go to their own window with `emit_to`, never a broadcast.
- `src-tauri/src/device.rs`: `#[tauri::command]`s, each resolving its session by the calling window's label (`NO_SESSION` when there is none). `viewer_info` (no token), `whep_offer`/`whep_close` (Location kept in Rust; refused if on another origin), `tap`/`swipe`/`input`/`open_url` (refused locally for `view` scope), `close_viewer` (`release: boolean`; sends the close event to this window's relay when attached, refuses `release` when detached with `DETACHED`, then destroys only this window), `open_billing` (no argument: opens the launch-time `billingUrl` through the opener plugin from Rust; `NO_BILLING_URL` when absent), `screenshot` (save panel, PNG written in Rust), `viewer_streaming`, `fit_window`. `viewer_info` carries `hasBillingUrl`, never the URL. Errors serialise as `{code, message}`.
- Capabilities (`capabilities/default.json`, windows `dev-*`): `core:default`, `dialog:default`, `log:default`, `core:window:allow-set-always-on-top`. The opener plugin is registered in Rust only and grants JS no permission.
- `src/core/api/device.api.ts`: `invoke` wrappers (`DeviceError` carries `code`).
- Two stream receivers, picked once per webview by `stream-engine.ts`. Both use non-trickle WHEP (`device::post_offer`; Revyl's bridge answers trickle PATCH with 400):
  - **native** (WebKit, i.e. macOS): Revyl's sender splits SPS/PPS into its own same-timestamp frame, and WebKit's receiver never assembles a frame of it. So Rust receives the WebRTC stream (`src-tauri/src/native_stream.rs`, webrtc-rs, H264 PT 98 only, SRTP replay window 4096 because the SFU reorders whole keyframes past the default 64), `reorder.rs` releases packets in sequence (200 ms wait per gap), `h264.rs` builds Annex-B access units per RTP timestamp (drops to the next keyframe on loss, PLI every 500 ms while waiting) and `native_stream_start` streams them over a Tauri `Channel` as `[kind u8][rtp ts u32 BE][body]` (kind 0 delta, 1 key, 2 state name). `native-session.ts` decodes with WebCodecs `VideoDecoder` onto a `<canvas>`; `native-frames.ts` is the pure parsing. The host log prints `native stream: N frames (K key), P PLIs` every 5 s.
  - **webview** (Chromium, i.e. WebView2 on Windows): `whep-session.ts` (RTCPeerConnection recvonly, offer after ICE gathering, reconnect on failed/disconnected) into a `<video>`; `whep-diagnostics.ts` logs `[whep]` state and stats to the console.
  - `use-device-stream.ts` runs the right one; `whep.ts` holds the shared backoff and `iceGatheringComplete`; `viewer.tsx` is the window layout.
- `src/modules/stream/billing-state.ts` (pure reducer and `overlayFor` precedence: expired, then out-of-credits, then stopped), `use-billing.ts` (event listeners), `stopped-state.tsx` (the overlays). A stop drops the stream like expiry. The titlebar shows a quiet "Low balance · top up" badge only when `hasBillingUrl`.
- `src/modules/interaction/`: the input path, active only in drive mode (never in `view` scope or watch mode). `interaction-layer.tsx` wraps the picture and maps pointers to **device points** (`geometry.ts`, using `deviceSize` from `device_screen()`, fetched once streaming; never picture pixels). `touch-session.ts` classifies a press (12 px drag, 500 ms long press, else tap; 8 ms move throttle) and calls `DeviceActions`. `createDeviceActions({device, onError})` (`device-actions.ts`, `viewer.tsx` memoises it) implements them over `core/api/device.api.ts`: touch events buffer and nothing is sent until `touchUp`, which becomes `tap`, `longPress` (press point + duration), a `swipe` or a `drag`; `flick.ts` picks swipe when the release took under 250 ms and travelled 40 points or more (dominant axis), else drag along the real path. Two-finger events buffer until `multiTouchUp` (pinch at their centre). With the live input socket ready (`stream/use-input-socket.ts` over `input-connection.ts`: connects once streaming in drive scope, `ready` event marks it up, `closed` or a failed connect retries with the WHEP backoff 1s to 15s), touches stream as down/move/up frames and goHome, shake, location, input, key, openUrl, orientation, multiTouch are frames too (`transport.ts`: a press keeps the path it started on); otherwise the HTTP path above runs, and a live send failing with `NO_INPUT` falls back to HTTP. `setOrientation` is a no-op over HTTP, so Rotate is enabled only while the socket is ready. A rejected call goes to `onError` (shown as the notice). `whep-session.ts` builds its `RTCPeerConnection` with `streamIceServers()` (TURN). `text-batcher.ts` debounces typing into `input`. `logActions` only logs (previews, tests).
- `src/modules/toolbar/`: apogee toolbar (open URL, screenshot, watch/drive toggle for `drive` scope, always-on-top, status badge) and `DeviceControls` (home, shake, rotate, set location; rotate stays disabled, "Needs live input (coming soon)", unless `canRotate`, which is the socket's ready state).

## Window chrome

- Undecorated, transparent window (`decorations: false`, `transparent: true`, `shadow: true`); the rounded surface is CSS. `macOSPrivateApi` is on for transparency on macOS, which rules out the Mac App Store (the viewer never ships there).
- The titlebar is ours: `data-tauri-drag-region` on the bar, non-interactive children `pointer-events-none`. Window controls are custom buttons plus Cmd/Ctrl+W (close) and Cmd/Ctrl+M (minimize).
- Window capabilities are exactly `core:window:allow-start-dragging`, `allow-minimize`, `allow-close`, `allow-set-always-on-top`. Add one only with the control that needs it.
- `TITLEBAR_HEIGHT` and `SCREEN_INSET` (`src/modules/toolbar/layout.ts`) feed `fit_window`; change them with the markup or the window no longer fits the device aspect.
- Aspect lock: `fit_window` runs on the first frame and again when the stream aspect changes >1% (rotation, `window-fit.ts`). It keeps the video area's long edge, so a rotation swaps the screen around the window's centre (`aspect::fit`, 90% of the monitor at most), and swaps the minimum size for landscape. It also stores a per-window lock (`src-tauri/src/aspect.rs`: `constrain` keeps the dragged axis, derives the other, holds the 260×420 minimum) that native resize hooks apply mid-drag, so the video never letterboxes: macOS adds `windowWillResize:toSize:` plus `windowWillStartLiveResize:` / `windowDidEndLiveResize:` to tao's `TaoWindowDelegate` at runtime and re-sets each window's delegate (`aspect_macos.rs`); Windows subclasses the HWND and rewrites the `WM_SIZING` rect (`aspect_windows.rs`). Edge drags keep the dragged axis; corner drags take the nearest size with the ratio (least squares, continuous). macOS proposes start size + pointer travel, so a drag is classified against its start size (`aspect::Session`), never the last frame, or a diagonal drag flips between axes and jitters. Locks are keyed by native handle and dropped on `Destroyed`.
- App icon (`src-tauri/icons/`) is generated from warden-monorepo's `packages/brand/assets/warden/icon-1024.png`, never hand-edited: `bun run icons` (fetches it from GitHub `@develop` via `gh`; `--ref <ref>`, a local `<brand-dir|png>` arg or `WARDEN_BRAND_DIR` instead). It copies back only what `bundle.icon` lists plus `icon.png`; `source.sha256` pins the master, so an unchanged one is a no-op (`--force` to regenerate; `.icns` output is not byte-reproducible).

## Commands

```bash
bun run dev            # tauri dev (Vite :3231 + Rust); feed the stdin JSON by hand
bun run build:frontend # tsc + vite build
bun run tauri:build -- --debug --bundles app   # macOS bundle
bun test               # TS unit tests
bun run test:rust      # cargo test
bun run typecheck && bun run check
```

Smoke: `echo '{"apiUrl":"http://127.0.0.1:9","deviceId":"d1","token":"wvt_x","expiresAt":"2030-01-01T00:00:00Z","scope":"drive","title":"t","platform":"ios"}' | "<bundle>/Contents/MacOS/warden-viewer"` prints `{"event":"ready"}`; closing stdin exits 0 and closes the window. Two relays with different `deviceId`s (keep each stdin open, e.g. a FIFO) give one `warden-viewer --host` process, one dock icon and two windows; ending one relay's stdin closes only its window. Host logs: `$TMPDIR/warden-viewer/<key>.log`.

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

All six `APPLE_*` must be set for macOS signing; otherwise none is used. Signed builds use the hardened runtime and are notarized and stapled by Tauri. There is no entitlements file on purpose: the viewer only receives WebRTC video (UDP from Rust on macOS, WebView2 on Windows), needs no camera or microphone, and is not sandboxed. Do not enable the App Sandbox. Windows builds a bare exe (`--no-bundle`); the `windows_subsystem = "windows"` GUI process still reads the parent's piped stdin/stdout.

Local pack: `bun run tauri:build -- --bundles app && bun run pack:asset darwin-arm64` (add `--profile debug` after a debug build).

## Rules

- TDD: pure logic gets a failing `*.test.ts` first; Rust pure bits get `#[cfg(test)]` tests.
- The token never crosses `invoke` toward JS, and never goes to argv, env, logs or the DOM.
- No `any`, no barrel exports, no comments inside JSX, no new plugins or capabilities without a reason.
- `routeTree.gen.ts` is generated by the Vite plugin and committed.
