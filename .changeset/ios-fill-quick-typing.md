---
"@delacour/warden": patch
---

- iOS `warden ui fill` and the spec `fill` type the first attempt at quick key pacing when the field is read back afterwards, and retype at the normal pacing if it does not match: on the example app a 15-character email fills in ~0.6 s instead of ~0.85 s and 60 characters in ~1.3 s instead of ~2.5 s. Secure fields, `--secure`, `--no-verify`, `type` and `clear` keep the normal pacing. Setting any `WARDEN_SIMD_PACE_MS` / `WARDEN_SIMD_HOLD_MS` / `WARDEN_SIMD_REPEAT_GAP_MS` / `WARDEN_SIMD_LEAD_MS` turns the quick attempt off.
- iOS: a secure field that holds text is emptied with select-all and one Backspace, then checked to show no bullets (any left are backspaced one by one), instead of one Backspace request per bullet: re-filling a 9-character password takes ~0.8 s instead of ~1.7 s.
