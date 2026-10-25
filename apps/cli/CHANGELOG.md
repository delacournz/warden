# @delacour/warden

## 0.2.0

### Minor Changes

- [#58](https://github.com/delacournz/warden/pull/58) [`03136f3`](https://github.com/delacournz/warden/commit/03136f3b414cfce9849183b7b522ffc52086d677) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden-simd` links idb v1.7.7, whose typed bridge answers replace the generic frame decode: the helper's CPU per accessibility read drops by about three quarters (host 9.12 → 3.79 CPU-seconds per bench rep on EAS `macos-large` with the equivalent patch), memory unchanged. A guest that stops answering now surfaces as `E_TIMEOUT` with the seconds allowed.
  - `WARDEN_SIMD_TIMEOUT` (a duration, e.g. `60s`) sets the per-request timeout of the helper client `warden ui` and the e2e runner connect with; the default stays 10 s.
  - `warden e2e` / `warden dev` honour the core `eas: false` opt-out and never call eas-cli when it is set.
  - Golden settle probe works without a GUI launchd session (hosted workers, ssh).

### Patch Changes

- [#69](https://github.com/delacournz/warden/pull/69) [`1d39a21`](https://github.com/delacournz/warden/commit/1d39a21a0f24e3cef6c44130f8d948c3250d1620) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `typeText` with characters the HID keyboard cannot type (`café`, emoji, CJK) pastes the right text again on Xcode 27.1: the simulator pasteboard is written through `devicectl device pasteboard copy` (falling back to `simctl pbcopy`) and confirmed with `pbpaste` before the paste keystroke. `simctl pbcopy` exits 0 there without changing the pasteboard, so the field used to receive whatever the Mac had copied last. An unconfirmed write is now `E_IO` and nothing is pasted.
- Updated dependencies []:
  - @delacour/warden-e2e@0.2.0

## 0.1.2

### Patch Changes

- [#64](https://github.com/delacournz/warden/pull/64) [`2569b9c`](https://github.com/delacournz/warden/commit/2569b9cf7cbadc24b9ca0830233d420f78d1e6ba) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Releases now flow through a changesets "Version Packages" PR into `develop`; merging it fast-forwards `main`, which deploys the docs and publishes the npm packages together.
- Updated dependencies []:
  - @delacour/warden-e2e@0.1.2
