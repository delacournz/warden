---
"@delacour/warden": minor
---

- Every iOS simulator warden creates boots already slim by default. `--slim` / `--no-slim` on `claim`, `run`, `dev`, `batch` and `e2e`, config `slim` (top-level, `e2e.<suite>.slim`, `batches.<name>.slim`) as `true | false | { except, keep }`, and `WARDEN_SLIM=0` choose per run, per suite or per machine.
- The slim overrides are written to the simulator before its first boot, so clones come up slim with no per-daemon spawns. Once the sim is ready they are read back, and any drift is fixed live.
- `warden sim slim --except <categories>` and `--keep <labels>` leave whole categories or single `com.apple.*` labels running. `warden sim profiles` lists the categories.
- `warden sim measure [udid|--booted]` prints a booted simulator's real memory (summed `phys_footprint`) and its heaviest processes. `warden devices --mem` adds the figure to the device list.
- `warden capacity` counts a slim simulator at the slim figure instead of the full one, so more simulators fit. `cost.ios.slimMemMb` overrides it.
- `gamed` and `nanotimekitcompaniond` are no longer disabled, and are re-enabled on a simulator an older warden already slimmed.
- A plain `warden claim` no longer restores a slimmed simulator. `warden sim slim --restore` does.
