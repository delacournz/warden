---
"@delacour/warden": patch
---

- Every word warden passes to `adb shell` from the host is quoted for the device's shell: app ids, device paths and the dev-client URL (`warden dev`, `warden perf`, app installs, native logs) arrive as single words. Lease undo quotes the settings values it restores and restores a timezone only when it is a timezone id (else the host's).
- App ids are checked where they enter, and the error names the source. Android application ids are two or more dot-separated segments of letters, digits and `_`, each starting with a letter; iOS bundle ids are letters, digits, `.` and `-`. This covers `--bundle-id` (`warden init` checks it for the platforms it fills in), `warden perf --app`, `warden ui … --app` (a `usage` error) and the id read from `warden.config.ts`, the app config or the native project.
- `warden dev --scheme` (and the `exp+<slug>` default) must be a URL scheme: a letter, then letters, digits, `+`, `.`, `-` or `_`.
- `{udid}` in an e2e suite's `setup` command is substituted as one shell word.
- `warden affected` / `warden e2e`: a `--base` that starts with `-` is an error, and the project's TypeScript is loaded only from a `node_modules/typescript` package named `typescript` whose entry file is inside it.
- Without a git checkout, `warden.config.*` and the app config are looked for in the directory warden is run in (a configured project below it still finds that config), not in its parents; inside a checkout the search still goes up to its root.
