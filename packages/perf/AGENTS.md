# @delacour/warden-perf

Pure core of `warden perf`: capture argv builders, parsers, analyzers, the session schema and the markdown renderer. No CLI code, no I/O of its own (side effects are injected by `apps/cli/src/perf/*`).

## Layout
```
src/shared/   session.schema.ts, findings.types.ts, render-md.ts, caps.ts, app-detect.ts, doctor-parse.ts
src/metrics/  ps.ts (ps / adb top parsers, cpu deltas; shared with e2e-bench)
fixtures/     real captured command output the parser tests read
```
Later phases add `frames/`, `startup/`, `js/`, `react/`, `ios/`, `android/`, `logs/` (see `docs/plans/wdn-prf.md`).

## Rules
- Parsers take text and return typed rows or a `Result`; they never spawn.
- Every report is a `Finding[]` (`shared/findings.types.ts`) rendered by `shared/render-md.ts` (capped, with `next:` hints).
- Fixtures are real output, not hand-written approximations.
