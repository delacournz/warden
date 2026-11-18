---
"@delacour/warden": patch
---

- Anonymous usage telemetry now sends a fixed code for why a command failed, beside its exit code and error class: the `warden ui` error code (`target_not_found`, `wait_target_absent`, `engine_unavailable`, `failed` …), the claim code (`NO_DEVICE` …), `negative_answer` for a `warden ui is` that answered false (or a `warden ui a11y audit` that found errors), and `tests_failed` for a `warden e2e` gate that failed. It never sends the message. `warden telemetry disable` or `DO_NOT_TRACK=1` turns it off.
