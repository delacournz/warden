# Audit brief (read this first, then your `ASSIGN-<nn>.md`)

You are one of 21 auditors reading the warden codebase at commit `dfcc68b` (branch `claude/laughing-mayer-wtoxx7`, repo root `/home/user/warden`). The goal of the audit: find where the `warden` CLI and the `@delacour/warden-e2e` stack can be made faster (wall time per e2e flow, time to boot cold iOS simulators and Android emulators), lighter (host and device CPU, RSS) and sounder (races, leaks, flake risks, error paths), and report it with evidence an engineer can act on. Your assignment names one improvement goal and the files you own.

## 1. Read before you start

- `AGENTS.md` (root), `apps/cli/AGENTS.md`, `packages/e2e/AGENTS.md`, `packages/core/AGENTS.md`, `packages/e2e-bench/AGENTS.md`: layout, rules, and a lot of measured behaviour.
- `docs/plans/wdn-perf.md`: § Context (the hotspot table), § Targets, § Results, § Follow-ups. This is the previous perf pass. Where it says a fix landed, check that it did.
- `docs/bench/ios-2026-10-16-perf.md` and `docs/bench/android-2026-10-16-perf.md`: the only measured numbers you have. Quote them when you estimate impact.
- Frozen contracts: `packages/e2e/src/driver/driver.types.ts` and the `WARDEN_*` names in `packages/e2e/src/env.ts`. A fix that changes them is `contract: driver` or `contract: env`, not `additive`.

## 2. Hard rules

- **Read-only on source.** No edits, no `bun test -u`, no snapshot updates, no `bun install`, no network, no git commits. The only files you write are the two output files named in your assignment.
- Never run `xcrun`, `simctl`, `adb`, `emulator`, `warden-simd`, `swift`, `javac`. None exist here; there are no devices.
- You may run: `bun test <path>` (one file or a directory under your owned files), `bun run --cwd <pkg> typecheck`, `git log`/`git blame`/`git show`, `grep`/`rg`. Prefix every `bun` run with `WARDEN_HOME=/tmp/claude-0/-home-user-warden/0a2fe730-4741-59a0-9ff9-2eb7af339b55/scratchpad/home-<nn>` (your agent number) so nothing touches a real home. Other agents are running tests at the same time: do not read timings into anything.
- Stay inside your owned files. When a call path leaves them, follow it far enough to understand the mechanism, cite the owner's area, and stop. The file owner reports the finding; you add only what your side contributes (a call count, a caller that defeats a cache).
- Do not propose lowering the iOS key pacing (hold 40 ms / pace 30 ms): it is the measured lossless floor (K9).

## 3. Method

- Trace real call paths end to end. Count spawns, reads, sleeps and RPCs per operation. Mechanism beats impression: "this `await` serialises N devices" with the line, not "this looks slow".
- Pin every citation as `path:line@dfcc68b` (line numbers from the files as they are now; the suffix just records the commit).
- Impact is `measured` (a number from the bench docs or a plan table, cited) or `estimated` (show the arithmetic: per-call cost × calls per test × tests per rep). Never present an estimate as a measurement.
- Where the previous pass claims a fix (`docs/plans/wdn-perf.md`), verify it in the code. If it did not land, the finding is `claimed-fixed-not-landed`.
- A fake (`fake-simd.ts`, `fake-adb.ts`, `uiad.testing.ts`, `driver.testing.ts`) that drifts from the real server keeps tests green while devices fail: when your scope includes a fake, diff it against the real wire.

## 4. Known items (K-refs)

Every finding that touches one of these must cite its K-ref and set `Known?` to `known-confirmed`, `known-extended` (you add mechanism, a number or a fix), `known-stale` (no longer true) or `claimed-fixed-not-landed`.

| K | Known item (source) |
|---|---|
| K1 | Untraced time 6.8 s (iOS) / 7.7 s (Android) per rep on the hand-rolled suite; partly stale: the idiomatic suite reaches 0.27 s / 0.11 s (`docs/plans/wdn-perf.md:672`) |
| K2 | Bench sampler has no per-process RSS split; iOS host RSS 116 → 149 MB unattributed (`wdn-perf.md:689`) |
| K3 | Compiled binary 116 MB (mostly `typescript` bytecode); compiled `warden version` RSS 57 MB vs ≤ 50 MB target (`wdn-perf.md:650,680`) |
| K4 | `run`/`dev` still load core zod config schemas eagerly (`wdn-perf.md:680`) |
| K5 | Static round-robin sharding; crash blame inferred from result order (`wdn-perf.md:684`) |
| K6 | `warden-uiad` verified on API 37 only; no CI emulator matrix; snapshot p95 ~270 ms right after navigation under load (`wdn-perf.md:687`) |
| K7 | AX guest wedge root cause unknown; `WARDEN_SIMD_GUEST_MAX_AGE_S` 12 s is a workaround tuned to one suite cadence (`wdn-perf.md:688`) |
| K8 | Fresh-checkout `app ensure` bugs: fingerprint changes during `expo prebuild`; `locateArtifact` mtime rule (`wdn-perf.md:690-691`) |
| K9 | iOS key pacing hold 40 / pace 30 is the lossless floor, never lower it; typing garbles only under heavy host load (`wdn-perf.md:50,685`) |
| K10 | `warden e2e <suite> --platform android` refuses `slim: true` suites (`wdn-perf.md:686`) |
| K11 | Bench prepare 708 ms cold (isolation stops the helper) vs ≤ 300 ms target; warm 182 ms (`wdn-perf.md:646`) |
| K12 | iOS host CPU avg 12.1 % / RSS 149 MB vs targets 5 % / 110 MB (`wdn-perf.md:647`) |
| K13 | One bench test failed once under load; timing-flake watch (`wdn-perf.md:683`) |
| K14 | `console.jsonl` ring not cleared per attempt; "no results.jsonl" warning printed for a fully skipped flow (`docs/plans/wdn-e2e.md:468-469`) |
| K15 | `app.open({wait:"quiet"})` settles before the welcome screen is visible: 2.6 vs 2.2 s/rep iOS, 4.8 vs 2.0 s Android (bench docs, "What changed") |
| K16 | `simctl launch --terminate-running-process` once took > 30 s (`LAUNCH_MS`, `wdn-e2e.md:467`) |
| K17 | `warden ui` on Android pays ~85 ms `warden-uiad` start per CLI call; daemon mode noted as optional (`wdn-perf.md:549`) |
| K18 | `settle{bundleId}` right after a relaunch is dominated by app boot (4.5–6.4 s), pass/fail ambiguous (`wdn-e2e.md:392-396`) |

## 5. Outputs (exactly two files)

### 5.1 `docs/audit/raw/<nn>-<slug>.md`

Sections, in this order:

1. `## Top 5 by impact`: five finding IDs with one line each.
2. `## Findings`: one `### <nn>-<k> <Title>` per finding with these fields as a bullet list:
   - `Category`: perf-latency | perf-cpu | perf-ram | cold-boot | correctness | robustness | flake-risk | test-gap | dx
   - `Severity`: P0 (breaks, corrupts or flakes a run) · P1 (≥ 1 s per test, or ≥ 10 % CPU/RSS, or a real race) · P2 (100 ms–1 s per test, or a moderate robustness gap) · P3 (polish; at most 5 per agent)
   - `Known?`: new | known-confirmed Kn | known-extended Kn | known-stale Kn | claimed-fixed-not-landed (cite the plan line)
   - `Evidence`: `path:line@dfcc68b` citations and the mechanism, in enough detail that a reader can confirm it without you
   - `Impact`: measured (cite) or estimated (arithmetic), per test and per 8-test rep where that makes sense; name the platform
   - `Proposed fix`: a sketch, the files to touch, and whether it is additive or changes a contract (driver | wire | env | cli | store)
   - `Effort`: S (< 2 h) · M (≤ 1 day) · L (> 1 day)
   - `Risk`: what could regress, and whether the change needs a device to verify
   - `How to verify`: the test to write or run, the bench to re-run, or the on-device check
   - `Confidence`: high | med | low
   - `Verified by`: read | ran `bun test <path>` | traced path from X to Y
3. `## Known items`: every K-ref you touched, with its status and one line.
4. `## Gaps I could not assess here`: what needs a device, with the exact command or measurement to run there.
5. `## Owned files not read`: list them, or "none".
6. `## Questions for the user`: at most two, only if an answer would change a recommendation.
7. `## Files read`.

### 5.2 `docs/audit/raw/<nn>-<slug>.jsonl`

One JSON object per finding, one per line, no blank lines, matching the `.md`:

```json
{"id":"<nn>-<k>","title":"...","severity":"P0|P1|P2|P3","category":"perf-latency|perf-cpu|perf-ram|cold-boot|correctness|robustness|flake-risk|test-gap|dx","known":"new|known-confirmed|known-extended|known-stale|claimed-fixed-not-landed","kref":"K7|null","platform":"ios|android|both|host","primary":"path:line","files":["path",...],"est_saving":{"unit":"ms/test|ms/rep|MB|pct-cpu|spawns/run|n/a","value":0,"basis":"measured|estimated"},"effort":"S|M|L","risk":"low|med|high","needs_device":true,"policy_change":false,"contract":"additive|driver|wire|env|cli|store","depends_on":[],"cross_owner":[],"confidence":"high|med|low"}
```

`cross_owner` lists the agent numbers whose files the fix would also touch. `policy_change` is true when the fix changes a default users rely on (shutdown policy, isolation, snapshot reuse, timeouts users see).

## 6. Budget

0–20 findings. Evidence is required for every one; a hunch without a line is not a finding. Depth beats breadth: one call path traced end to end is worth more than ten impressions. Stop when your owned files are covered. When you are done, end with one line naming the two files you wrote.
