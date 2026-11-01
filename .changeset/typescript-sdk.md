---
"@delacour/warden": minor
---

- New `@delacour/warden-sdk` package: `createWardenClient` drives leased iOS and Android devices from TypeScript with the same operations as `warden ui` (open, snapshot, press, fill, scroll, gestures, wait, get, devtools, close), returning typed results and errors.
- `session.record` writes e2e specs from a session (same engine as `warden ui record`), `session.perf` profiles startup, metrics, memory, frames, JS, heap, logs and crashes (same engine as `warden perf`), and `warden.specs` lists, selects (`affected`) and runs suites.
- `session.devtools.route()` / `nativeLogs()`, shared leases, `devices.viewer()` / `arrange()`, and iOS sessions recover a lost HID connection once.
- Plugin providers persist across processes: leases record their provider, `warden.config.ts` takes `providers`, and `warden ls` shows a PROVIDER column for plugin leases.
- `ai-sdk` tools for recording, perf and route; `screenshot` hands the image to the model.
- Every `warden ui --json` result and every perf/record/arrange `--json` output follows a published zod schema, covered by golden tests.
- Provider, claim, port and app-build failures carry typed error codes instead of a generic `failed`.
