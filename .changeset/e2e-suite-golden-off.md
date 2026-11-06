---
"@delacour/warden": minor
---

- `e2e.<suite>.golden` in `warden.config.ts`: `true` clones the suite's new iOS simulators from a golden image. It is off by default, so `warden e2e` now creates fresh simulators (`simctl create` + first boot) unless a suite opts in. `WARDEN_GOLDEN=0` still turns the golden off everywhere.
- `warden ci cache --suite <name>`: the golden group is `null` when the suite (or the only suite) does not set `golden: true`, and the e2e action then skips restoring, building, saving and collecting a golden.
