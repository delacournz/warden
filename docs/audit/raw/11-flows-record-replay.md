# 11 flows-record-replay

Scope: `packages/e2e/src/flows/*`, `apps/cli/src/agent-ui/{flow-sink,flow-actors,flows-command,record,flows-register}.ts`, `apps/cli/src/commands/ui-flows.test.ts` (the assignment's `ui-flows.test.ts` lives in `commands/`). Ran `bun test src/flows` (83 pass), `bun test src/commands/ui-flows.test.ts` (14 pass), `bun run --cwd packages/e2e typecheck` (clean, goldens included). The O(n) append number below comes from a throwaway script in the scratchpad (loaded machine, so read it as a shape, not a benchmark).

Two corrections to the assignment text: appends are serialised by an `O_EXCL` lock file next to the flow (`record.ts:253`), not a store transaction; and the "2.4 s per step" (`wdn-e2e.md:316`) was measured on the dump driver under load average 50-170, where a dump alone was 3.5-8 s. It is one snapshot per step plus a tap, not flow overhead. What flow code adds is the extra snapshots in 11-5/11-6.

## Top 5 by impact

1. 11-2: replay's landmark check makes a moved element look absent, so `is hidden`, `wait hidden|detached` pass falsely and `wait visible` burns its full timeout.
2. 11-1: every recorded `type` and `key` step exports as a `throw new Error("FIXME ...")`; the sink never records a target for them.
3. 11-3: the append lock gives up after 5 s but only treats a lock as stale after 10 s, so a killed recorder silently drops 1-2 steps.
4. 11-4: `record start` writes a `state.json` copy read before `await env.driver()`, which can erase the helper record the driver connect just wrote.
5. 11-5: replay takes 2 snapshots for every `is|get|wait|scroll-until` step and throws away the settle snapshot; with 11-6 this is roughly 1.5 snapshots per step too many.

## Findings

### 11-1 Recorded `type` and `key` steps are never exportable
- Category: correctness
- Severity: P1
- Known?: new
- Evidence: `flow-sink.ts:100-107` builds `type` as `{ kind: "type", ...base, text }` and `key` via `keyStep(base, key)` (`flow-sink.ts:132-136`); `base` (`flow-sink.ts:79-83`) has no `target`, and the `type --submit` extra step is `{ kind: "key", at, key: "Enter" }` (`flow-sink.ts:103`). `export.ts:237-246` calls `located(step.target, ...)`, which for `undefined` returns `unsupported(...)` (`export.ts:191-194`), i.e. a comment plus `throw new Error("FIXME: typing without a target field ...")`. `export.test.ts:143-147` asserts this for untargeted steps, but no test feeds the sink's output into export. The spec API does have `Locator.type|press` (`screen/locator.ts:567,579`) and nothing device-level, so the target has to come from somewhere.
- Impact: any recording that uses `warden ui type` or `key` (the usual way to enter text after a `press` on a field, or to submit) exports a spec that throws at that step, so the export is useless for the common sign-in flow. Not a timing issue; affects both platforms. Estimated: every flow with at least one `type`/`key`, which is most flows beyond a single `fill`.
- Proposed fix: in `export.ts`, carry the last selector target of a `press`/`fill`/`longpress` forward as the implicit field for a following untargeted `type`/`key` (comment it `// field: <selector>`), and keep the FIXME only when no earlier target exists. Alternative: have the sink copy the previous step's target onto `type`/`key` when it appends. The first is purely in `export.ts` and needs no schema change (`type.target` and `key.target` are already optional, `flow.schema.ts:113,119`).
- Effort: S
- Risk: low; a wrong guess of the focused field yields a spec that types into the wrong element, so mark it with a comment and leave the FIXME when a different step intervenes (home, back, open, alert).
- How to verify: add an `export.test.ts` case for `press` -> `type` -> `key` and a golden; extend `ui-flows.test.ts` "record start -> actions -> stop" with a `type`/`key` action and assert the exported spec has no FIXME.
- Confidence: high
- Verified by: traced path from `flowRecordSink.append` to `exportFlow`; ran `bun test src/flows`.

### 11-2 Landmark check turns "moved" into "absent" in `find`, so negative assertions pass falsely
- Category: correctness
- Severity: P1
- Known?: new
- Evidence: the lazy kinds (`wait`, `is`, `get`, `scroll`) look targets up through `ActContext.find` (`replay.ts:387-394`), which runs `toLocated -> resolveTarget` (`replay.ts:267-270`). `resolveTarget` applies the landmark rule (role equal, centre within `LANDMARK_TOLERANCE = 40`, `replay.ts:242-250`) and returns `{ divergence }` as `{ missing }`. The actors then read "missing" as absent: `present = "resolved" in located` and `showing = ... entry?.visible === true` (`flow-actors.ts:67-68`). So `is hidden` takes `entry === undefined` as true (`flow-actors.ts:178-188`), `wait detached` is `!present` (`flow-actors.ts:163-166`), `wait hidden` is `!showing`. An element that is still on screen but 41 pt away (list reflow, banner above it, different keyboard height) or that changed role satisfies all three. In the other direction `wait visible|attached` on the same moved element polls until the whole budget (`step.timeoutMs ?? timeoutMs`, `flow-actors.ts:160`) and then reports `did not become visible`, the wrong reason.
- Impact: false pass for negative assertions (the dangerous direction: a regression that leaves the element on screen at a new position goes green); for positive waits a wasted full timeout (default is `env.timeoutMs`, seconds) plus a misleading message. Both platforms. Also `scroll --until` reports the target as not showing while it passes the landmark (`flow-actors.ts:149`), and keeps swiping past it.
- Proposed fix: make `find` return a third state, e.g. `{ resolved, moved?: string }` or `{ missing, present: boolean }`: element found by the chain but outside the landmark is "present, moved". `wait`/`is`/`get` should use the element for state checks and only report the move as a warning (or as a divergence for `press`-like kinds where position matters). Keep the strict check for eagerly resolved kinds. Files: `replay.ts` (`Located`, `toLocated`), `flow-actors.ts`.
- Effort: M
- Risk: med; changes which replays pass, so flows that were passing for the wrong reason will now fail or warn. No device needed.
- How to verify: new `replay.test.ts` cases with a FakeDriver screen where the element moved 100 pt: `is hidden` must fail, `wait detached` must fail, `wait visible` must pass with a warning. There is no test of `flow-actors.ts` at all today (see 11-17).
- Confidence: high
- Verified by: read; traced `find -> toLocated -> resolveTarget -> present/showing`.

### 11-3 Append lock: waiters give up before a dead holder's lock is stale, and stale-breaking races
- Category: robustness
- Severity: P1
- Known?: new
- Evidence: defaults are `timeoutMs: 5000` and `staleMs: 10_000` (`record.ts:278-281`). A lock is only broken when `Date.now() - mtime >= staleMs` (`record.ts:243-251`), where mtime is the creation time (the file is never touched while held, `record.ts:222-240`). If a recorder is killed between lock create and release (Ctrl-C, OOM, `timeout`), the next `warden ui` action finds a lock aged < 10 s, waits 5 s, and returns `lock_timeout`; the sink prints a yellow warning and drops the step (`flow-sink.ts:213-217`). Every action in the next ~10 s is lost the same way, and each costs 5 s of wall time. The holder's pid is written (`record.ts:225`) but never checked with `kill(pid, 0)`. Second issue: `breakIfStale` does stat then unlink as two steps. Two waiters A and B both stat the same stale file; A unlinks it and creates a fresh lock; B (already past the stat) unlinks A's fresh lock and creates its own. Both now hold "the" lock and the read-modify-write can lose a step. The window is small but it is exactly the situation after a crash with two agents recording.
- Impact: lost steps are silent in `--json` (the warning goes to stderr) and the recording replays as a different flow (a missing press). Each lost step also costs a 5 s stall inside a `warden ui` call. Both platforms.
- Proposed fix: check the pid in the lock file with `process.kill(pid, 0)` and break at once when it is dead; set `staleMs` below `timeoutMs` (or make the wait `staleMs + margin`); break a stale lock by `rename` to a unique name then unlink, or re-stat just before unlink and compare inode/mtime. Optionally retry the step once. Files: `record.ts`, `record.test.ts`.
- Effort: S
- Risk: low; pid reuse can make a dead holder look alive, which just falls back to the stale timer. Needs no device.
- How to verify: `record.test.ts`: write `${file}.lock` containing a dead pid with a fresh mtime and assert the append succeeds in well under `timeoutMs`; a test with `now`/`sleep` injected for the unlink race.
- Confidence: high for the 5 s < 10 s mismatch, med for the race (needs the exact interleaving).
- Verified by: read; the existing tests ("a stale lock is broken", "a held lock times out") only cover `staleMs: 0` and `staleMs: 60_000`.

### 11-4 `record start` can overwrite concurrent `state.json` writes (helper record)
- Category: robustness
- Severity: P1
- Known?: new
- Evidence: `uiRecordStart` reads `state` at `flows-command.ts:60`, then awaits `env.driver()` and `health()` (`flows-command.ts:69-71`), and finally writes `{ ...state, recording }` at `flows-command.ts:94`. `writeState` is a plain whole-file atomic write with no lock or merge (`state.ts:146-150`). When `env.driver()` starts the resident helper, `helper.ts:393` does `writeState(host, udid, { ...readState(host, udid), helper: record })` in between, and the later write from the stale copy puts back a state without `helper`. The next `warden ui` call then finds no helper record and starts a second `warden-simd` (the first one lives on until its idle timeout), and any collector/video entry written by another process in that window is lost the same way. `record stop` has the same pattern (`flows-command.ts:106-112`) but no await in between.
- Impact: extra helper start per lost record (iOS cold `warden ui snapshot` is 544-726 ms vs 182-185 ms warm, `docs/bench/ios-2026-10-16-perf.md:26`), plus a leaked resident process. Estimated: only on the first `record start` of a cold device, so one occurrence per recording session. Medium confidence because it depends on whether this path actually spawns the helper (iOS driver connect) rather than finding one.
- Proposed fix: re-read right before writing: `writeState(ctx, udid, { ...readState(ctx, udid), recording })`. Better, give `state.ts` a `updateState(ctx, udid, patch)` that does read-modify-write inside `store.transaction` (owner: `state.ts`, not this audit's file). Files: `flows-command.ts` (one line), `state.ts` (optional).
- Effort: S
- Risk: low.
- How to verify: `ui-flows.test.ts` with a fake driver whose `health()` writes `helper` into `state.json`, then assert it survives `record start`.
- Confidence: med
- Verified by: traced path from `uiRecordStart` through `env.driver()` to `helper.ts:393`.

### 11-5 Replay takes more snapshots per step than it needs
- Category: perf-latency
- Severity: P2
- Known?: new (explains the per-step cost in `docs/plans/wdn-e2e.md:316`)
- Evidence: driver `snapshot` calls per step kind, from `runStep` (`replay.ts:357-410`):
  - `home|back|alert|rotate|appearance|screenshot|open|type|key`, no hash: 0 (`wantsScreen`, `replay.ts:341-342`). With a recorded `snapshotHash` they take 1, only to compute a drift warning (`replay.ts:374-375`); `open` is excluded.
  - `press|longpress|fill|swipe(target)`: 1, shared by drift and placement.
  - coordinate `press|longpress|swipe(path)` that carries a hash: 1, used only for the drift warning, which never fails the replay.
  - `wait|is|get`: 1 for drift (their slots are emptied by `eagerSlots`, `replay.ts:155-157`, but `step.snapshotHash` is always set when recorded with evidence, `flow-sink.ts:37`) plus at least 1 inside `find` (`replay.ts:391`), taken within milliseconds of each other on the same screen. `wait` adds one per poll.
  - `scroll --until`: 1 for drift plus 1 per loop iteration (`flow-actors.ts:147`); `swipeWithin` reuses `c.snapshot` when set (`flow-actors.ts:84`) so it adds none when a hash was recorded.
  - Any step with `settle`: `takeSnapshot` polls (see 11-6) and the screen it ends on is discarded (`flows-command.ts:196-204` returns it as `unknown`, `replay.ts:406`); the next step snapshots again although nothing ran in between.
- Impact: estimated, `is|get|wait` steps and settled steps pay one snapshot too many. iOS warm snapshot p50 47-70 ms (`wdn-e2e.md:300-307`), so 50-70 ms per affected step; Android under load 2.4-5.7 s per dump (`wdn-e2e.md:316`), where it is the whole "2.4 s per step"; Android with `warden-uiad` is far lower but unmeasured for this path (K6 range: p95 ~270 ms). For a 20-step flow with 6 lazy steps and 8 settled steps that is 14 snapshots, about 0.7-1 s iOS.
- Proposed fix: (a) seed `find`'s first call with `ctx.snapshot` when the step already took one; (b) keep the last snapshot in `runStep` state and let the next step reuse it when the previous step was `settle` or an observation-only kind and its age is under ~100 ms; (c) skip the drift-only snapshot for coordinate steps (or add `--no-drift`); (d) have `deps.settle` return the settled snapshot. Files: `replay.ts`, `flow-actors.ts`, `flows-command.ts`. Additive.
- Effort: M
- Risk: med; reusing a snapshot after an action would be wrong (stale), so reuse only across steps that did not touch the device; fake-driver tests can pin the call counts. No device needed to implement, a device to measure.
- How to verify: `replay.test.ts` asserting `driver.callsOf("snapshot")` per kind (the harness already counts); on device `warden ui replay` of a 20-step flow, compare `events[].ms` before and after.
- Confidence: high on the counts, med on the saved time.
- Verified by: traced path from `replayFlow` through `runStep` to the actors.

### 11-6 Replay's `--settle` polls snapshots instead of using the driver's settle and ignores `quietMs`
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence: `flows-command.ts:196-204` implements `settle` as `takeSnapshot(... settle: { budgetMs })`. `fetchSnapshot` (`snapshot.ts:94-118`) polls `driver.snapshot()` through `settleByHash` with `quietMs: DEFAULT_SETTLE_QUIET_MS` (250, `settle.ts:44`). The recorded `settle.quietMs` (`flow.schema.ts:66-69`) is dropped, and the `Driver.settle` op (`driver.types.ts:194`) is not used even though the iOS server answers it from the AX quiescence stream ("settle quiet in <400 ms on idle screen", `wdn-e2e.md:178`). `takeSnapshot` also commits a new generation and rewrites `last-snapshot.json` in a store transaction on every settled step (`snapshot.ts:236-246`), which replay never reads.
- Impact: estimated: each settled step costs at least 250 ms quiet plus 2 full snapshots (hash needs two equal reads) and a transaction, against one `driver.settle` round trip. With `--settle` on every step (`flows-command.ts:176-182`) a 20-step flow pays about 20 x (250 ms + 2 snapshots), 5-6 s on iOS where the native op would be about 1-2 s. Unmeasured; needs a device.
- Proposed fix: call `driver.settle({ quietMs, timeoutMs })` first and fall back to hash polling on `E_UNSUPPORTED`; pass the recorded `quietMs`; skip `storeSnapshot` during replay. Files: `flows-command.ts`, maybe `snapshot.ts` (owner outside this audit).
- Effort: S
- Risk: low-med; the native settle can report `quiet:false` where hash polling would pass; keep the existing warning-only behaviour.
- How to verify: `ui-flows.test.ts` fake driver counting `settle` vs `snapshot`; on device `warden ui replay --settle` timing before/after on iOS.
- Confidence: med
- Verified by: read; traced `deps.settle -> takeSnapshot -> fetchSnapshot`.

### 11-7 On Android the screen hash ignores static text, so drift and replay settle are blind to text changes
- Category: correctness
- Severity: P2
- Known?: new
- Evidence: `snapshotHash` hashes `(role, identifier, label, value, frame)` only (`settle.ts:77-96`). The Android driver knows this and folds `text` into `value` before hashing for its own settle (`android-driver.ts:507-508`). The CLI-side callers do not: the recorder (`flow-sink.ts:37`), replay drift (`replay.ts:374`), `takeSnapshot` (`snapshot.ts:145`) and replay's settle (11-6) all call plain `snapshotHash`.
- Impact: on Android a screen where only a label's text changed (loading placeholder -> content) hashes the same, so replay's `--settle` can return early on a still-changing screen and drift never fires for text changes. Flake-risk for replay steps that follow a settle; platform Android only.
- Proposed fix: move the text fold into `snapshotHash` itself (or export a `hashOf(snapshot, platform)`) so every caller gets it. `settle.ts` belongs to another owner; this audit adds the callers listed above.
- Effort: S
- Risk: med; changes the hash value, so every recorded `snapshotHash` on Android flows reads as drift once (warning only) and `--update-snapshots` fixes it.
- How to verify: a unit test with two Android-shaped snapshots differing only in `text`; on device `warden ui replay` after changing a label.
- Confidence: med
- Verified by: read.

### 11-8 `replay --from N` past the end passes with zero steps
- Category: correctness
- Severity: P2
- Known?: new
- Evidence: `parseFrom` only checks `^\d+$` (`flows-command.ts:148-153`); `replayFlow` skips `step.i < from` (`replay.ts:418-419`) and returns `status: "passed", steps: 0` (`replay.ts:434-439`). The command prints `replayed 0 steps of "..."` with exit 0 (`flows-command.ts:282`).
- Impact: a CI script or agent that resumes with a stale index gets a green result for a replay that did nothing. Both platforms.
- Proposed fix: after loading, `from >= flow.steps.length` is a usage error; likewise an empty flow could warn. File: `flows-command.ts`.
- Effort: S
- Risk: low.
- How to verify: `ui-flows.test.ts`: `--from 99` exits non-zero.
- Confidence: high
- Verified by: read.

### 11-9 `--update-snapshots` does not refresh landmarks of `wait`, `is`, `get` and `scroll --until` steps
- Category: correctness
- Severity: P2
- Known?: new
- Evidence: landmarks are refreshed from `placed.refreshed` (`replay.ts:335,409,424`), and `place` only sees `eagerSlots` (`replay.ts:363,377`), which are empty for the lazy kinds (`replay.ts:153-157`). Their targets are looked up by `find`, whose resolved result is not fed back. The step does get a new `snapshotHash` (`replay.ts:425`), so the file looks refreshed.
- Impact: after the app layout changes by more than 40 pt, `replay --update-snapshots` passes (11-2 hides it for negative checks), writes new hashes, but leaves those landmarks stale, so the next plain `replay` diverges or false-passes again. The hint printed on divergence says `--update-snapshots only refreshes recorded positions` (`flows-command.ts:235`), which is then partly untrue.
- Proposed fix: let `find` record the resolved entry per slot in `runStep` and merge it into `refreshed`; do it together with 11-2 since both touch `find`/`Located`. Files: `replay.ts`.
- Effort: S
- Risk: low.
- How to verify: extend `replay.test.ts` "updateSnapshots returns a refreshed flow" with a `wait` and an `is` step whose element moved.
- Confidence: high
- Verified by: read.

### 11-10 `export --ids` rewrites the user's ids module from scratch
- Category: robustness
- Severity: P2
- Known?: new
- Evidence: when new keys were added, the whole file is replaced by `idsModuleText(exported.ids)` (`flows-command.ts:354-357,308-312`). `loadIds` only requires that `ids` be an object of strings (`flows-command.ts:293-306`); comments, other exports, grouping or differently formatted entries are lost. The spec is written before the ids file (`flows-command.ts:349-356`), so a failure in between leaves a spec that imports missing keys. `used` is detected by `spec.includes("ids.")` (`flows-command.ts:353`), a substring test that a typed string such as `"ids."` also satisfies, instead of the generator's own `uses.ids`.
- Impact: silent loss of hand-written content in a committed file; the exported spec is fine. Both platforms.
- Proposed fix: append the new `key: "id",` lines before the closing `} as const` of the existing text (regex on the `ids` object literal), and fall back to a printed diff when the file is not in that shape; export `uses.ids` from `exportFlow` instead of the substring test; write ids before the spec. Files: `flows-command.ts`, `export.ts` (return a flag).
- Effort: M
- Risk: low-med; text surgery on user files needs careful tests.
- How to verify: `ui-flows.test.ts` with an ids module containing a comment and a second export; assert both survive.
- Confidence: high
- Verified by: read; `ui-flows.test.ts:333` covers only a plain module.

### 11-11 Secret redaction covers exact matches only and skips `get.expected`
- Category: robustness
- Severity: P2
- Known?: new
- Evidence: values are redacted only when the whole text equals a `WARDEN_UI_SECRET_*` value (`record.ts:125-129`; `record.test.ts:115` deliberately keeps "text that merely contains a secret" literal). `fill|type` go through it (`flow-sink.ts:63-66`), but `get` stores `expected` as the raw string (`flow-sink.ts:193-199`) although the schema and replay treat `expected` as a `Text` that may be a secret (`flow.schema.ts:150`, `replay.ts:181-189`) and export emits a variable for it (`export.ts:323`). Targets also carry on-screen text: `targetFromElement` writes `element.text` and `label` into `role-text` selectors and the landmark `label` (`record.ts:86-91,106`); a second step on a plain (non-secure) field whose earlier-typed secret is now in the snapshot stores that value in the file.
- Impact: a token or password can reach the `.flow.json` (and an exported spec) through `get` expectations, "Bearer <token>"-style texts, or the selector of a later step on the field. The `--secure` path is covered. Both platforms.
- Proposed fix: run `redactSecrets` on `get.expected` and on every selector/label string before writing, and substring-redact (replace the secret with a marker and store as a `Text` template) or at least warn when a recorded string contains a secret value. Files: `flow-sink.ts`, `record.ts`.
- Effort: S for `get.expected`, M for the substring case.
- Risk: low; substring redaction changes the file shape (a template Text) and needs a schema addition, so that part is `additive` with a schema bump consideration.
- How to verify: `ui-flows.test.ts`: set `WARDEN_UI_SECRET_X=hunter2`, run `get value ... hunter2` and `fill` twice on one field, then grep the file for `hunter2`.
- Confidence: high for `get.expected`, med for the selector path (depends on the platform exposing field text as `text`).
- Verified by: read.

### 11-12 Each append re-parses and re-serialises the whole flow (O(n) per step)
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `appendStep` reads the file, `JSON.parse` plus a full `flowSchema.safeParse` (`record.ts:286`, `155-169`), then builds `next` and runs `flowSchema.safeParse(next)` again over every step (`record.ts:292`), then `JSON.stringify(flow, null, 2)` and a temp-file write plus rename (`record.ts:294`, `143-153`). Two zod passes over n steps per append.
- Impact: measured with a scratch script (typical press step with a 4-link chain, loaded host, shape only): cumulative append time 193 ms at 100 steps, 842 ms at 250, 2.7 s at 500, 9.4 s at 1000 (file 833 KB), i.e. about 2 ms per append at 100 steps and about 13 ms at 1000. Real recordings of tens of steps pay 1-3 ms per action, so this is not a user-visible cost today.
- Proposed fix: validate only the new step with `stepSchema` plus the `i` rule, skip the second full parse, and keep the `[` `]` structure so an append can splice the new step text before the closing bracket (one read of the tail, no parse). Only worth doing if long recordings become a use case. File: `record.ts`.
- Effort: S for the single-parse version, M for splice.
- Risk: low.
- How to verify: `record.test.ts` for order and validity; rerun the 1000-append loop.
- Confidence: high
- Verified by: ran a scratch script (not committed).

### 11-13 `v` is a literal 1 with no migration path or helpful error
- Category: dx
- Severity: P3
- Known?: new
- Evidence: `v: z.literal(1)` and `z.strictObject` everywhere (`flow.schema.ts:175`, `record.ts:162-167`): a file with another version or any unknown field is `flow_invalid` with zod's first issue (`record.test.ts` writes `{"v":2}` and only checks the code).
- Impact: the first schema change breaks every existing recording with an opaque message. Not a performance issue.
- Proposed fix: parse `v` first and return `flow written by a newer warden (v2)` or run a `migrate(v1 -> v2)`; consider `passthrough` on the top level only. Files: `flow.schema.ts`, `record.ts`.
- Effort: S
- Risk: low.
- How to verify: `flow.schema.test.ts` with `v: 2` and an extra top-level field.
- Confidence: high
- Verified by: read.

### 11-14 Export edge cases that produce a spec that does not parse or typecheck
- Category: correctness
- Severity: P3
- Known?: new
- Evidence: (a) the header comment embeds `JSON.stringify(flow.name)` on a `//` line (`export.ts:405`); U+2028/U+2029 in a name are not escaped by `JSON.stringify` and end a JS comment, so the rest of the name becomes code (the `note` path is safe, it collapses `\s+`, `export.ts:393`). (b) secret variables are `camel(name)Secret` per distinct name (`export.ts:155-167`), so `A_B` and `a-b` both become `aBSecret` and the spec declares it twice; and `process.env.WARDEN_UI_SECRET_${name}` (`export.ts:398`) is not valid for a name with `-` or `.` (use `process.env[...]`). (c) a `throw` followed by more steps (`export.ts:187`) leaves unreachable statements that Biome's `noUnreachable` flags in the generated file. Goldens (`export.golden/all-steps.e2e.ts`) are typechecked and pass, but none covers these.
- Impact: none for normal names; a broken generated file for unusual names. Both platforms.
- Proposed fix: escape ` | ` in `lit`; dedupe variable names with a counter; use `process.env[lit(...)]` when the name is not an identifier; comment out (not throw) the remaining steps or end the test after the first FIXME. File: `export.ts`.
- Effort: S
- Risk: low; goldens change only if the cases appear (do not regenerate them; add new ones).
- How to verify: `export.test.ts` cases for each.
- Confidence: med
- Verified by: read.

### 11-15 Landmark tolerance is a fixed 40 units and replay does not look at `recordedOn`
- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence: `LANDMARK_TOLERANCE = 40` (`replay.ts:18`) is compared with frames in the driver's native unit. `recordedOn.platform|device|screen{width,height,scale}` is written (`flows-command.ts:76-86`) but nothing in `replay.ts` or `flows-command.ts` reads it: a flow recorded on iOS replays on an Android device and diverges with "moved 900 pt" instead of "wrong platform". On Android the snapshot is in pixels (the 1080x2424 AVD reports 2424x1080 when rotated, `wdn-e2e.md:316`) while iOS is in points, so the same 40 is about 15 dp on a 420 dpi emulator against 40 pt on an iPhone.
- Impact: estimated: tighter tolerance on Android turns small layout shifts (status bar, keyboard, font scale) into `replay_divergence`, which fails the replay (flake-risk on Android). Not measured; needs a device.
- Proposed fix: refuse or warn on a platform mismatch; scale the tolerance by `recordedOn.screen.scale` relative to the current screen (or express it as a fraction of screen width, e.g. 40 pt at 390 pt wide). Files: `replay.ts`, `flows-command.ts`. Additive.
- Effort: S
- Risk: med; changes pass/fail boundaries.
- How to verify: `replay.test.ts` with an Android-scale screen; on device, replay a recording after toggling the keyboard.
- Confidence: low (the Android unit is inferred from the doc, not read from the driver)
- Verified by: read.

### 11-16 Replay hides its own log lines
- Category: dx
- Severity: P3
- Known?: new
- Evidence: `log: () => undefined` in `flows-command.ts:206`. Everything `replayFlow` logs is dropped: the coordinate-target warning (`replay.ts:330`), drift lines (`replay.ts:351`), step failures (`replay.ts:398`) and settle failures (`replay.ts:407`; `flows-command.ts:196-204` also never reports them). Drift only appears through `onStep`.
- Impact: a failed `--settle` or a step that replays by coordinates (which will not survive a layout change) is invisible to the user and to `--json`.
- Proposed fix: collect `log` lines into the result (`details.log`) and print them to stderr unless `--json`. File: `flows-command.ts`.
- Effort: S
- Risk: low.
- How to verify: `ui-flows.test.ts` replaying a coordinates flow.
- Confidence: high
- Verified by: read.

### 11-17 No tests for `flow-actors.ts`, lock races, or sink-to-export
- Category: test-gap
- Severity: P3
- Known?: new
- Evidence: `flow-actors.ts` (238 lines: `wait`/`is`/`get`/`scroll` semantics, `fill`, `open`) is only reached through the 14 tests in `commands/ui-flows.test.ts`, none of which exercises a negative `is`/`wait`. `record.test.ts` covers stale (`staleMs: 0`) and held locks but not a dead holder with a fresh mtime or the stale-break race; the cross-process test (`record.worker.testing.ts`, 2 processes x 15 appends) is sound for ordering but small. No test passes sink output to `exportFlow`.
- Impact: 11-1, 11-2, 11-3 and 11-9 all went unnoticed for these reasons.
- Proposed fix: add `flow-actors.test.ts` with a fake `ActContext` and `FakeDriver`; a sink-to-export round trip in `ui-flows.test.ts`.
- Effort: M
- Risk: low.
- How to verify: the new tests fail on the current code for 11-1, 11-2, 11-9.
- Confidence: high
- Verified by: read; ran both test files.

## Known items

- K15, K18: not touched directly. Replay's `open` always relaunches (`flow-actors.ts:95-99`, `relaunch: true`) and a following `settle` on the first step hits the K18 ambiguity, but nothing flow-specific to add.
- K6: 11-5 uses the "~270 ms p95 right after navigation" figure for the Android snapshot cost; unchanged.
- `docs/plans/wdn-e2e.md:316` ("replay step ~2.4 s"): known-stale as a flow cost. It was one dump-driver snapshot under load average 50-170; what flow code adds is in 11-5/11-6.

## Gaps I could not assess here

- Real per-step replay time on iOS and Android with `warden-uiad`: record a 10-step flow, then `warden ui replay f.flow.json --json` and read `events[].ms`; repeat with `--settle`. Compare before/after 11-5/11-6.
- Whether Android frames are px and what `recordedOn.screen.scale` holds there (11-15): `warden ui snapshot --json` on an emulator, compare frame width with `health().screen`.
- Whether `env.driver()` spawns the helper on a cold `record start` (11-4): `warden ui record start x` on a device with no helper, then `cat $WARDEN_HOME/ui/<udid>/state.json` for a `helper` key.
- Android text-only change (11-7): replay a flow across a label change and see whether `drift` fires.
- Native `driver.settle` vs hash polling cost on iOS (11-6): time `warden ui press --settle` against `warden ui wait stable`.

## Owned files not read

none (`flow.testing.ts` and `replay.test.ts` were read in part: the step fixtures after line 60 of `flow.testing.ts`, `export.golden/with-ids.e2e.ts`, `default-import.e2e.ts`, `ids.ts` and `flow.schema.test.ts` were skimmed or not opened; `ui-flows.test.ts` was read by test name only).

## Questions for the user

1. Is a recorded `type`/`key` meant to apply to "the focused field" (then 11-1 is an exporter inference) or should the recorder capture the focused element (changes `warden ui type`)?
2. Are long recordings (hundreds of steps) an intended use? If not, 11-12 can be dropped.

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-11.md`, `docs/plans/wdn-e2e.md` (lines 149-160, 300-330)
- `packages/e2e/src/flows/{record,replay,export,flow.schema,record.worker.testing,replay.testing}.ts`, `record.test.ts` (lines 130-243), `export.test.ts` (lines 1-60, 137-150), `replay.test.ts` (test names, lines 269-311), `flow.testing.ts` (lines 1-60), `export.golden/all-steps.e2e.ts`
- `apps/cli/src/agent-ui/{flow-sink,flow-actors,flows-command,flows-register,record}.ts`, `act.ts` (lines 60-130), `query.ts` (lines 160-200, 293-335), `target.ts` (60-175), `snapshot.ts` (88-165, 225-250), `state.ts` (136-170), `helper.ts` (375-395)
- `packages/e2e/src/driver/settle.ts`, `driver.types.ts` (grep), `screen/field.ts` (162-175), `screen/nodes.ts` (grep), `screen/screen.ts`/`locator.ts` (grep)
- `apps/cli/src/commands/ui-flows.test.ts` (test names)
