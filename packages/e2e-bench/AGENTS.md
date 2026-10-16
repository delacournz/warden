# @delacour/warden-e2e-bench

Benchmarks six mobile e2e frameworks on the example app's parity suite (plan: `docs/plans/wdn-bench.md`). Private, never published.

- `src/cli.ts`: `bench run | doctor | list | report | compare` (root: `bun run bench …`).
- `src/adapters/<framework>.ts`: one `BenchAdapter` each (`adapter.types.ts`); `parse/` turns native reporter output into canonical `TestResult[]`; fixtures under `src/adapters/fixtures/`.
- `src/harness/`: `exec.ts` (the only spawn seam, `fakeExec` for tests), `device.ts` (claim/release), `app.ts` (`warden app ensure`), `phases.ts`, `sampler.ts`, `residue.ts`, `isolation.ts`.
- `src/results/`: `schema.ts` (zod, `bench-results.json` v1), `stats.ts`, `manifest.ts` (`suites/manifest.json`: canonical ids ↔ native names), `footprint.ts`.
- `src/report/`: `markdown.ts`, `html.ts`, `svg.ts`, `compare.ts`.
- `suites/<framework>/`: the 8 parity tests per framework; `suites/manifest.json` is the join key.
- Output: `.bench/<run-id>/` (gitignored).

## Rules
- Never spawn in `bun test`: inject `Exec` (`fakeExec`). Never install global tools; `doctor` prints hints.
- Devices come from `warden claim`; release exactly the lease ids claimed (never `--mine`).
- Every suite must encode the same retries as `apps/example/e2e/helpers/flows.ts` (dropped first Next press, dropped first tab/row tap after sign-in, deep-link retry) so no framework gets an easier test. Zero LLM, `retries=0`.
- `Result`/`AsyncResult` from `@delacour/warden-types/result`; no `any`; no barrels; colocated tests; TDD.
