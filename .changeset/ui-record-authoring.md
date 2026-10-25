---
"@delacour/warden": minor
---

- `warden ui record start|note|undo|use|status|cancel|stop` (#63): every `warden ui` action and query is journalled under `$WARDEN_HOME/ui/<udid>/`, and `stop` writes a typed `@delacour/warden-e2e` spec (or an exported helper) directly, then runs it once on the leased device (`--no-verify` skips). The journal is kept until a passing `stop` or a `cancel`, so you can `undo`, fix and `stop` again.
- `record use` runs an exported helper on the device, then records an import and a call to it.
- Generated specs use durable selectors only (testID > role+label > text); `snapshot -i` marks elements without one as `[no-id]`. Lints: `coords_target`, `text_only_selector`, `ambiguous_selector`, `unverified_navigation`, `empty_recording`.
- Secrets typed through `WARDEN_UI_SECRET_<NAME>` never land in the spec; testIDs are merged into an ids module; `wait` / `is` / `get` become auto-waiting expects; `app.open({ wait: "quiet" })`.
- Recordings reuse the suite's shared `test.use` options and emit `launch: "none"` when the recording or its helper opens the app itself.
- `stop` prints the `specs.<id>` entries for `warden.config.ts` from the routes seen on a dev client (helper routes merged); it never edits the config.
