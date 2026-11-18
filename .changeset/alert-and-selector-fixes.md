---
"@delacour/warden": patch
---

- `warden ui` selectors accept multi-word bare values: `warden ui press 'label=Try Face ID Again'` works without quotes, and the value ends at the next `role=`, `nth=` or other key.
- `warden ui alert accept` presses "Try Face ID Again", "Try Again" or "Retry" on a Face ID sheet instead of "Cancel", and fails with `ACTION_FAILED` naming the buttons when none is affirmative rather than pressing a cancel button.
- `warden ui alert get` lists each alert button once.
- `warden ui alert accept` and `device.alert("accept")` press "Try Face ID Again" once and answer: on a simulator the "Face Not Recognized" sheet stays up after it, which no longer fails with `ACTION_FAILED` "alert still showing". `device.biometrics.match()` also works from that sheet without pressing Try Again.
