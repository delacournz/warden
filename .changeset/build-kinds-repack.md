---
"@delacour/warden": minor
---

- New `warden repack ios|android [--project <dir>] [--force] [--json]`: bundles this worktree's JS into the cached simulator build in seconds (the native base is built once per native fingerprint) and prints the base hash, `jsKey`, artifact, `reused` / `repacked`, bundle time or the fallback reason. Exit 1 when Android images changed and no repack is possible.
- Build kinds: `projects[].kinds.<dev|simulator|release>` (`build`, `env`, `jsInputs`) and `app: { kind }` in an e2e suite. `simulator` is a Release build with no JS embedded plus a per-JS repack keyed by content, not branch; `release` embeds the JS; `dev` is the Debug dev client.
- `warden e2e` now defaults to the repacked simulator build, repacked once before the devices install: a JS edit no longer rebuilds native. A suite's `metro` block applies only with `--dev` (or when the suite pins `app.kind: "dev"` / `app.variant`). Suites with `app.variant` behave as before.
- `warden e2e --dev` runs the dev client on a Metro warden starts (the suite's `metro` block, or the defaults); `--kind dev|simulator|release` picks the build. They can't be combined with each other or with `--variant`.
- `warden app ensure`, `run`, `batch` (`--app`) and `warden ui open` take `--kind`; `warden ui open --kind simulator|release` installs that build, relaunches when it changed and launches without Metro. Defaults are unchanged without the flag.
- A project's `fingerprint.include: "native+js"` now warns once on stderr when a run asks for `--kind dev` or `simulator`, which key on the native fingerprint.
- `warden builds ls` shows each build's kind, base, jsKey, worktree, branch, size and age; `--json` carries them.
- The claim spinner of `warden e2e`, `batch` and `run --app` now says what the app is really doing (building the ios app (fingerprint …), fetching the EAS build, repacking JS, waiting for another device's build) and only says installing once an install actually starts.
- Android repacks sign with the project's `android/app/debug.keystore` when present.
