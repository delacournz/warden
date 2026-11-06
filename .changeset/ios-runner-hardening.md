---
"@delacour/warden": patch
---

- iPhone runner: an accessibility refusal during a `snapshot` (`kAXError…`, "Failed to get matching snapshot") no longer ends the runner; the read is retried once on the phone, then answered `E_AX_UNAVAILABLE` (retryable).
- iPhone runner: an op that holds XCUITest past its timeout is answered `E_TIMEOUT` (`detail.stage: "deadline"`) instead of hanging the runner; until it returns, other ops answer `E_TIMEOUT` (`detail.stage: "busy"`) at once and `health` reports `state: "busy"`.
- iPhone and simulator helpers: an element XCUITest cannot place (a null or infinite frame) is a zero-area, not hittable element, and a non-finite number is `null` on the wire, instead of failing the whole reply.
