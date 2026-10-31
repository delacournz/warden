---
"@delacour/warden": minor
---

- `warden gc` (and auto-gc) prunes stale goldens once a day: iOS golden sims and Android quick-boot snapshots an older Xcode runtime, golden recipe or system image left behind, GBs each. The current golden, an AVD with a running emulator and a profile whose key can't be read are kept, and a golden being built or cloned is skipped, never waited on. `gc --json` lists them under `goldens`.
- `WARDEN_GOLDEN_PRUNE=0` turns it off; `warden golden prune` still prunes by hand.
