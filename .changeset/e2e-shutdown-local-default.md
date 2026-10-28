---
"@delacour/warden": minor
---

- `warden e2e`: a passed gate now shuts down the sims / emulators warden created (and closes their windows) locally too, not only under `CI`. Set the suite's `shutdown: "idle"` to keep them booted for the next run, or pass `--no-shutdown`.
