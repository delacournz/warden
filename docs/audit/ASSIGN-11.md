# Assignment 11 · `flows-record-replay` (sonnet, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/11-flows-record-replay.md` and `docs/audit/raw/11-flows-record-replay.jsonl`.

## Improvement goal

Faster flow replay (about 2.4 s per step was seen on Android under load, `docs/plans/wdn-e2e.md:316`) and O(1) record appends, with correct export codegen.

## Owned files

- `packages/e2e/src/flows/{flow.schema,record,replay,export,flow.testing,record.worker.testing,replay.testing}.ts` and tests, `export.golden/**` (read, never regenerate)
- `apps/cli/src/agent-ui/{flow-sink,flow-actors,flows-command,record,flows-register}.ts` and tests (`ui-flows.test.ts`)
- Read-only context: `docs/plans/wdn-e2e.md` § Flows; `apps/cli/AGENTS.md` paragraph on `flows-command.ts`/`flow-sink.ts`/`flow-actors.ts`.

## Starting hotspots

- `record.ts` (313) + `flow-sink.ts`: each recorded `warden ui` action appends a step by reading, parsing, appending and atomically rewriting the whole `.flow.json` under a store transaction: O(n²) over a long recording; the durable selector chain built per step (how many snapshot reads?); secrets by `WARDEN_UI_SECRET_*` name (is the value ever written?).
- `replay.ts` (440) + `flow-actors.ts`: per step a fresh snapshot, chain resolution (id → role+label → role+text → path), landmark check (role equal, centre within 40 pt), optional `--settle` as recorded, hash comparison for `drift`: count driver calls per step kind and where the 2.4 s went (process start is outside your scope: cite agent 14).
- `export.ts` (421): codegen correctness for every step kind, `ids` map generate/merge, `FIXME` throws; golden coverage; any generated spec that would not typecheck against the public API.
- `flow.schema.ts` (211): zod parse per read/write; `v:1` migration path.
- `flows-command.ts` (383): `record start|stop|status`, `replay --from --update-snapshots`, `export --to --ids`: file I/O per command, `state.json.recording` handling across processes (cross-process append order claim).
- Tests: cross-process append test (`record.worker.testing.ts`) soundness; replay divergence paths.
