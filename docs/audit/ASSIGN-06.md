# Assignment 06 · `screen-query` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/06-screen-query.md` and `docs/audit/raw/06-screen-query.jsonl`.

## Improvement goal

Fewer snapshots and less CPU per locator read, and a provably correct observation cache (the class of bug where a cached snapshot of a screen still sliding in led to a mis-tap, `docs/plans/wdn-perf.md:96`).

## Owned files

- `packages/e2e/src/screen/{locator,query,queries,nodes,roles,text,selector,render,react-locator,screen}.ts` and their tests (`locator.test.ts` 750, `locator.read.test.ts`, `locator.tap-until.test.ts`, `locator.react.test.ts`, `locator.span.test.ts`, `observation.test.ts`, `excerpt.test.ts`, `query.test.ts`, `nodes.test.ts`, `render.test.ts`, `selector.test.ts`, `roles.test.ts`, `text.test.ts`, `queries.test.ts`, `screen.test.ts`, `react-locator.test.ts`, `system-alerts.test.ts`)
- `packages/e2e/src/screen/{element.testing,screen.testing,fixtures.testing}.ts`
- `packages/e2e/src/driver/observation-cache.ts` and its test
- Read-only context: `docs/plans/wdn-perf.md` PERF-2.1, PERF-2.2, PERF-2.4; bench "What changed" (snapshot counts did not move: assert-then-tap is two snapshots).

Not yours: `actions.ts`, `field.ts`, `poll.ts`, `context.ts` (agent 07; you may read `context.ts` to see how reads obtain an observation), matchers (07).

## Starting hotspots

- `indexSnapshot` per observe: what indexes are built (by id, by role, descendant text), their cost at ~120–190 nodes × 23 levels deep, and whether any is built eagerly on the success path (PERF-2.2 claimed lazy `subtreeText` and lazy excerpts: verify both landed; `nodes.ts:135-139` was the eager spot).
- `observation-cache.ts`: generation bumps (which calls bump), max age iOS 150 ms / Android 1 s, "only the first poll of a read may reuse", "actions and `boundingBox` never reuse": trace each rule to code and tests; find any path (e.g. `tap({until})`, `locator.read()`, `systemAlerts` modal check, `react-locator`) that reuses a snapshot it should not, or re-reads when it could reuse.
- `locator.ts` (836): resolution pipeline per read (scope, filter, nth, visible), `pickOne` ambiguity ranking (exact > substring > smallest frame > reading order) cost, `STALE_RISK_READS`, `excerpt` building on failure only, `read()` returning `{visible,text,value,checked}` from one observation.
- `queries.ts`/`query.ts`: text matching (case-insensitive substring, regex), innermost-match rule, how many passes over the node list per query.
- `render.ts` (shared with `warden ui`): string building per line, called on the hot path or only for excerpts/`screen-at-failure.txt`?
- `selector.ts` parser: per-call parse or cached.
- `react-locator.ts`: when the React tree accelerator kicks in (dev client), its cost (`tree.script` 1200 ms guard) and the fallback.
- Snapshot count per rep: using the bench numbers (165–173 snapshots, 62 taps per iOS rep), work out which reads are structurally unavoidable and which the cache could remove, and what a "server-side query" (not worth it per the plan) would and would not save.
