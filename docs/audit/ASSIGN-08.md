# Assignment 08 · `runner-session` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/08-runner-session.md` and `docs/audit/raw/08-runner-session.jsonl`.

## Improvement goal

Lower the fixed cost per test (`launch: "fresh"`, hooks, attempt deadlines, failure capture) and per spec process (preload, session, driver connect), and make the trace/results I/O cheap and lossless.

## Owned files

- `packages/e2e/src/runner/{test,attempt,scope,trace,span,step,results,artifacts,failure,callsite,fixtures.types}.ts` and tests (`runner.test.ts`, `trace.test.ts`, `results.test.ts`, `failure.devtools.test.ts`, …), `runner/fixtures/**`
- `packages/e2e/src/{session,preload,env,fixtures,fixture-session,traced-device,index,version}.ts` and tests (`session.test.ts`, `session.devtools.test.ts`, `preload.test.ts`, `env.test.ts`, `fixtures.test.ts`, `traced-device.test.ts`)
- Read-only context: `packages/e2e/AGENTS.md` § Tracing; `docs/plans/wdn-e2e.md` § Public spec API (semantics), § Artifacts; bench "Untraced time" (K1) and the per-rep counts (8 launches = 12.8 s, 17 `typeText` = 18.7 s, 170 snapshots = 13.0 s on iOS).

Not yours: `device.ts`/`app.ts` internals (agent 09; you own the fixture wiring in `fixtures.ts`), `screen/*` (06, 07), drivers.

## Starting hotspots

- Per test: what runs before the body (`launch: "fresh"` = terminate + launch + rebind + `systemAlerts`?), hook stack order (`scope.ts`), fixture construction per test (`fixtures.ts`, `fixture-session.ts`), `test.extend` teardown after failure; the 8 launches per rep are the biggest fixed cost on iOS: is anything in the launch path (`app.open`) duplicated by the runner (settle twice, alert probe twice)?
- `attempt.ts` (348): `AbortSignal` deadline per attempt, how a never-resolving driver call is cut, what happens to the driver connection after a timeout, retries (`retry` option) and `results.jsonl` only on the final attempt.
- `trace.ts` (175) + `span.ts`: `SPAN_BUFFER_MAX`, flush before the next step event and at attempt end (`appendFileSync` sizes), `ts` ordering, what a crash mid-attempt loses; `step-start/step-end` mirrored to stdout (console I/O per step).
- `results.ts`: `appendFileSync` per test, `readResults` zod per line (also used by the CLI, agent 13).
- `failure.ts`: `failure.png` + `screen-at-failure.txt` + a 10 s snapshot timeout when the app is unreadable (`wdn-e2e.md:450`); `console.jsonl`/`network.jsonl` attach; cost of a failure on the next test's start.
- `session.ts` (295): `globalThis` singleton, lazy `driver()` connect (socket vs stdio spawn), `span()` outside attempts, what `close` does at process exit (helper left resident by design).
- `preload.ts`: zod `readEnv`, version handshake, `setDefaultTimeout`, `openResults`; cost per spec process (relevant to per-flow isolation: bun start + preload + connect per flow).
- `env.ts`: parsing per read or once; any env read on the hot path.
- Untraced time (K1): which calls in your files run outside any step or span (hooks, fixture setup, `launch`), and whether the idiomatic suite's 0.27 s/0.11 s residue is accounted for.
