---
"@delacour/warden": minor
---

- New `describe.serial(title, body)` (also `describe(title, { serial: true }, body)`, which used to do nothing): the group's tests share one app launch, opened once before the group's `beforeAll`, and once a test fails the rest are recorded as `skipped` with the new error code `SKIPPED`. `retry` on a test inside such a group is `INVALID_ARGUMENT`
- In a `describe.serial` group the suite's `conditions` baseline is applied once, before the group's launch and `beforeAll`, instead of before every test: re-applied to the running app it restarted a live camera feed, which then stopped decoding QR codes
- `beforeAll` / `afterAll` now run with the scope's timeout, report their steps, and on failure write `failure.png`, `screen-at-failure.txt` and a `failed` or `timed-out` line in `results.jsonl` titled with the describe titles and the hook name. Before, a failed `beforeAll` left no result and no evidence for its group
- Fixtures a `beforeAll` / `afterAll` keeps past its end now fail with `SESSION` inside a test instead of acting outside any test
- A `describe` body that takes arguments or is `async` is now `INVALID_ARGUMENT`: describe bodies run at collection and get no fixtures
