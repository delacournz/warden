# WSDX — extend @delacour/warden-sdk after the develop rebase

Plan ID: **WSDX**. Branch: `feature/warden-typescript-sdk` (squash-rebased onto `origin/develop`, backup `backup/wsdk-pre-rebase`). Predecessor: WSDK (`docs/plans/wsdk-sdk.md`). No GitHub issues — phases live here only.

Goal: every capability develop shipped after the SDK branch forked (spec authoring, perf, Xcode 27 devtools, shared dev leases, specs runs) is reachable from the typed SDK, plus the WSDK deferred list. CLI keeps dogfooding the same engine functions; `--json` output unchanged (goldens + zod contracts).

Conventions (all phases): ops are `(session: OpSession | ClientCore, params) => AsyncResult<OpDone<R>, WardenError>`; facade throws `WardenError`; every call takes `{ signal?: AbortSignal }`; zod contract per new `--json` output in `packages/sdk/src/contracts/`; API report `packages/sdk/api/*.api.d.ts` regenerated with `UPDATE_API_REPORT=1`; TDD colocated `*.test.ts`; no barrels; no `any`; heavy modules lazy-imported so CLI cold start stays within 10%.

## WSDX-0 🔀 rebase (done first, serial)
Squash-merge onto develop, 102 conflicts resolved by 3 agents (ui/sdk ops · packages · cli/infra/docs). Flow recorder (`packages/flows`, `Session.flows`) removed to match develop #59. Exit: typecheck/check/test green.

## WSDX-1 ✨ `session.record` — spec authoring
Lift `apps/cli/src/agent-ui/authoring-*.ts` + `record-sink.ts` + `route-capture.ts` logic into `packages/sdk/src/ops/authoring/*`: `start({ name, suite?, helper? })`, `note(text)`, `undo()`, `use({ helper, args })`, `status()`, `cancel()`, `stop({ verify?: boolean }) → { file, lints, verified, configSnippet }`. Journal stays under `$WARDEN_HOME/ui/<udid>/`; `OpSession.recorder` carries it so every `session.interactions.*` call made while recording is journalled (same as CLI). CLI `warden ui record *` becomes an adapter. ai-sdk: `warden_record_*` tools in `all` set.

## WSDX-2 ✨ `warden.perf` / `session.perf`
Lift `apps/cli/src/perf/{orchestrate,query,...}` engine functions behind ops: `perf.start({ device, app, collect })`, `mark(label)`, `stop() → report`, `startup({ runs, cold })`, `metrics({ durationMs })`, `memory({ snapshot })`, `frames({ reset })`, `js({ durationMs })`, `heap.snapshot()/diff()`, `logs({ since, level, grep })` (async iterable for follow), `crashes({ since })`, `doctor()`, `ls()`. Typed `Finding` union re-exported from `@delacour/warden-perf`. Contracts for each `--json`. ai-sdk: `warden_perf_*` read-only tools.

## WSDX-3 ✨ `warden.specs` — run + affected
`specs.run({ suite, specs?, platform?, project? }) → E2eReport` (spawns the same runner `warden e2e` uses; streams `SpecEvent`s via `onEvent`/async iterable), `specs.affected({ base })`, `specs.list({ suite })`. Contract = e2e-report.json schema.

## WSDX-4 ✨ devtools + device additions from #55/#57/#51
`session.devtools.route()` (current route), `session.devtools.nativeLogs({ since, follow })`, HID recovery automatic in iOS session (verify), `leases.claim({ shared })` / `lease.shared` visible, `devices.viewer()` (Device Hub vs Simulator.app) and `devices.arrange()`.

## WSDX-5 ✨ plugin persistence + config providers
Store column `provider` on leases (migration + `PRAGMA user_version` bump); `warden.config.ts` `providers: [defineProvider(...)]` (or module specifiers) loaded by client and CLI; `devices.list/inventory/capacity` include plugin devices; a second process can open a session on a plugin lease. Conformance suite covers it.

## WSDX-6 ♻️ hardening
Remaining `err(string)` → `WardenError` in ios/android/claim/ensure; per-command ui result schemas for every subcommand; ai-sdk screenshot returned as an image content part (`toModelOutput`); drop apps/cli cluster-cycle allowlist if reachable.

## WSDX-7 📝 docs, examples, changeset
Docs pages: `sdk/authoring`, `sdk/perf`, `sdk/specs`; examples `record.ts`, `perf.ts`, `specs.ts`; update `docs/plans/wsdk-sdk.md` Status; changeset (`@delacour/warden` minor).

## Waves
W1: WSDX-0. W2 (parallel): WSDX-1, WSDX-2, WSDX-3, WSDX-4, WSDX-5. W3: WSDX-6, WSDX-7.

## Defaults taken (user pre-authorised "plan then implement everything")
1.a squash-rebase (one commit on develop) — per-phase commits kept on `backup/wsdk-pre-rebase`.
2.a authoring stays in `packages/e2e/src/authoring` (no new package).
3.a perf engine stays in apps/cli where it is CLI-bound; SDK wraps engine fns, lifting only what the client needs.
