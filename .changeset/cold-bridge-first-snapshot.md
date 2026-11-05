---
"@delacour/warden-e2e": patch
---

The iOS driver's first snapshot of a session waits for the in-sim bridge when a device starts cold: it retries bridge-not-ready failures (timeout, unavailable) with backoff (2 s, then 5 s) for up to 60 s, so the first spec on a fresh simulator passes without a suite `retry`. Other errors still fail at once, and after the first successful read the normal budgets apply. The wait shows as `coldBridgeMs` on the span.
