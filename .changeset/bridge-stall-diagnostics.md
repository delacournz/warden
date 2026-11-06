---
"@delacour/warden": patch
---

- iOS: a read that leaves the in-sim accessibility bridge now says why in the run's evidence: `results.jsonl` gets a `bridge` field (`fallbacks`, plus the `first` and `last` such read with their reason or error code), the `driver.snapshot` span in `trace.jsonl` carries the stall (`stallStage` `connect` / `read` / `warm-up` / `cooldown`, `stallReadMs` against `stallDeadlineMs`, `stallCold`, `stallGuestAgeMs`, `stallCooldownMs`, `stallProbes`), and `screen-at-failure.txt` notes on its second line that the tree was read on `ax` after a stall
