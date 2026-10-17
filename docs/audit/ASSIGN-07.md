# Assignment 07 · `screen-actions-poll` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/07-screen-actions-poll.md` and `docs/audit/raw/07-screen-actions-poll.jsonl`.

## Improvement goal

Fewer reads and sleeps per action and per assertion; a cheaper, still-correct fill/confirm path.

## Owned files

- `packages/e2e/src/screen/{actions,field,poll,context}.ts` and tests (`actions.test.ts`, `field.test.ts`, `poll.test.ts`), `poll.testing.ts`
- `packages/e2e/src/expect/{expect,matchers}.ts` and `matchers.test.ts` (423)
- Read-only context: `docs/plans/wdn-perf.md` PERF-1.1 (fill), PERF-2.3 (poll back-off, cheaper confirm, negation grace), PERF-2.4 (`tap({until})`, `systemAlerts`); `packages/e2e/AGENTS.md` § `selectAll` paragraph; bench "What changed".

Not yours: `locator.ts` resolution and the cache (agent 06), the drivers' typing primitives (03, 05).

## Starting hotspots

- `poll.ts`: 100 ms for the first second then 250 ms (PERF-2.3): verify, and check the deadline semantics (does the last poll land on the deadline? does a slow snapshot overshoot?). Who still polls at a fixed interval outside `poll.ts`.
- `field.ts` (175): `fill` = focus + select-all + type-over (iOS) / `typeText` (Android) + confirm reads (`CONFIRM_READS`, `FIELD_POLL_MS`, `hitTestField` ~10 ms vs a full snapshot); `STALE_RISK_READS`; secure-field bullets; the counted-Backspace retry. Count reads per fill in the common case and the retry case; compare with the measured ~0.3 s overhead beyond typing.
- `actions.ts` (153): actionability wait before tap/longPress/swipe (visible? enabled? hittable? settle?), `tapPoint` vs frame centre, and whether a tap takes its own snapshot even right after an assertion (bench says yes, by design: assess whether a bounded "fresh enough" rule could be safe).
- `context.ts` (226): `tryObserve`, how the observation cache is consulted per read vs per action, the abort signal plumbing, settle calls hidden in actions.
- `matchers.ts` (336): poll per matcher, `NEGATION_GRACE_MS` 1000 (does a `.not` still wait a full second after `settle` says quiet?), `expect.soft` aggregation, failure excerpt built only on throw, default 5 s assertion timeout interplay with the attempt deadline.
- `tap({ until, retries, windowMs })`: 4 s window and two re-sends by default; what a dropped first tap costs vs a shorter window with a settle check.
- `test.use({ systemAlerts })`: where in the poll loop the modal is checked and what it costs when no modal exists.
- Tests asserting with real sleeps instead of the fake clock.
