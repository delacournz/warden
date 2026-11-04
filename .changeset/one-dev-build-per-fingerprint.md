---
"@delacour/warden": patch
---

- `warden app ensure --kind dev` now warms the cache `warden dev` reads: one dev build per native fingerprint, keyed `<fingerprint>:dev`, shared by `warden dev`, `warden app ensure` (with or without `--kind dev`), `run|batch --app`, `warden ui open` and `warden e2e --dev`. Before, `warden dev` missed a build `app ensure --kind dev` had made and built its own copy.
- A dev build cached by an earlier warden under the plain `<fingerprint>` key (or found in a legacy cache dir) is reused as that build, and a device it is already installed on is not reinstalled: no rebuild after upgrading.
- Applies when the project's own build is the dev build (Debug, default or identical `build` command, no variant, no `fingerprint.include: "native+js"`, no `kinds.dev.env`); other projects keep their kind-less build as before. `warden app ensure` with no `--kind` reports `hash: "<fingerprint>:dev"` and `kind: "dev"` in `--json` for such projects.
