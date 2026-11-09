---
"@delacour/warden": minor
---

- `warden e2e`, `warden repack` and `app ensure --kind simulator` no longer wait for a fresh simulator base build before bundling: iOS runs the JS bundle alongside the native build, then Hermes-compiles and repacks once the base is ready
- Android: a simulator base built in the same run already embeds the worktree's JS, so its apk becomes the repack with no second bundle or re-sign; `warden repack --json` and `--json` kind facts report `fromBase: true`, and the log reads `simulator repack <jsKey> built from the base build's bundle`
