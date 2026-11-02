---
"@delacour/warden": minor
---

- New opt-in `reclaim: erase | uninstall | none` (default `none`) in `e2e` suites, `batches` presets and the top level of `warden.config.ts`, with `WARDEN_RECLAIM` as the fallback below config: when a run releases its devices, warden cleans them. `erase` shuts a simulator down and runs `simctl erase`; `uninstall` removes the user-installed apps. On Android, `erase` uninstalls the third-party apps.
- A `reclaiming` lease holds the device while it is cleaned, so no claim takes it mid-way. Only warden-created simulators and emulators are reclaimed: foreign, golden and physical devices are skipped.
- A failed reclaim quarantines the device with a `reclaim: ` reason and `warden gc` retries it after 30 s, then 60 s (capped at 5 min), 3 tries in all. After that it stays quarantined until `warden sim unquarantine <udid>`.
