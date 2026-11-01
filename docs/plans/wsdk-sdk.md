# Plan WSDK — warden as a typed TypeScript SDK + small reusable packages

## Context
`warden` is CLI-only today. The goal is the same shape as agent-device (`createAgentDeviceClient`, `agent-device/ai-sdk`, provider plugins): a fully typed `@delacour/warden-sdk` that third parties can build integrations on. The core logic is split into small, isolated workspace packages that the SDK, CLI and e2e runner all consume.

Repo: `delacournz/warden`. Bun + Turbo, ~58k LOC in three places:
- `packages/core` (13k): leases, store, providers, builds, golden, affected
- `packages/e2e` (21k): Driver, screen/Locator, devtools, flows, runner
- `apps/cli` (24k): commander, agent-ui, lease-session, metro, batch

Read `AGENTS.md`, `packages/e2e/AGENTS.md`, `docs/plans/wdn-e2e.md` before any phase.

### What the codebase map found (2026-10-24)
- **The building blocks already exist.**
  - `Driver` (`packages/e2e/src/driver/driver.types.ts`) is platform-agnostic, returns `Result` and never throws.
  - `openIosDriver({udid, exec})` and `openAndroidDriver({serial, adb, exec, …})` already run standalone; `warden ui` uses them.
  - `createScreen({driver, env})` works without the test runner.
  - `devtools/*` is fully self-contained: only types and zod, with `fetch` and `WebSocket` injected.
  - `DeviceProvider` (`core/src/providers/provider.types.ts`) is already a plugin-shaped interface.
  - No `console`, `process.exit` or chalk anywhere in core or the CLI business logic. Output goes through `CommandContext`.
- **Blockers:**
  1. **Errors are plain strings.** About 600 `err(string)` calls, and callers compare strings, e.g. `CLAIM_ABORTED` and `includes("did not answer within")`. Only `warden ui` has coded errors (`UiError`, `UI_ERROR_EXIT`).
  2. **No unified host type.** There are ~30 ad-hoc deps types (`ProviderDeps`, `ClaimInput`, `ClaimPortsDeps`, …) with the same fields: exec, store, env, now, pidAlive, sleep, log, owner. The CLI's `CommandContext` is the de-facto host.
  3. **Four cluster cycles in core:** affected↔builds, batch↔builds (via `builds/config.schema`), golden↔providers, golden↔sims.
  4. **e2e layering leaks:**
     - `driver/traced-driver.ts` imports `runner/span`.
     - `screen/context.ts` imports `env` constants.
     - `openDriver(env: E2eEnv)` requires a `bundleId`.
     - `locate-helper`, `open.ts` and `android-state` read `process.env` and `wardenHome()` directly.
     - `session.ts` is a `globalThis` singleton.
  5. **SDK-shaped logic is stuck in `apps/cli`:**
     - lease engine: `lease-session.ts`, `device-lease.ts`, `claim-flags.ts`, `lease-select.ts`
     - `metro.ts`
     - `commands/app.ts` prepare/ensure
     - agent-ui ops. Every `uiX` is `(ctx, deps, words[], opts) → exit code` and prints its own output; the typed result is `unknown`.
  6. **No curated public surface.** `exports: {"./*": "./src/*.ts"}` everywhere, ~45 deep `@delacour/warden-e2e/<internal>` imports, and test helpers that can be imported.
  7. **Bun-only.** `bun:sqlite`, `Bun.spawn`/`connect`/`sleep`/`hash`/`Glob`/`Transpiler`. `@delacour/warden-e2e` already declares `engines.bun`.

## Decisions (2026-10-24, user)
1. One bundled public package `@delacour/warden-sdk`; all split packages stay private.
2. Bun-only v1 (`engines.bun`).
3. Throw `WardenError` at the public boundary; `Result` stays internal.
4. No GitHub issues. Implement every phase on `feature/skipjack` with subagents; one local commit per phase.

## Target architecture
Dependencies only point down. Every package is `private` in the workspace (per `AGENTS.md`). Only the bundled SDK is published, alongside the existing three npm packages.

```
@delacour/warden-types        Result + WardenError union + WardenHost (exists, grows)
@delacour/warden-runtime      Exec, sleep, hash, spawn/connect seams; bun adapter (core/exec, git-facts)
@delacour/warden-store        types, liveness, store + migrations, wardenHome(host)
@delacour/warden-config       ALL zod schemas + define-config (breaks the builds↔affected↔batch cycles)
@delacour/warden-providers    DeviceProvider, ios, android, health, androidTools, golden-name leaf
@delacour/warden-leasing      allocate, queue, capacity, host, claim, ports, owner, room
                              + lease-session/device-lease/lease-select/claim (moved from cli)
@delacour/warden-builds       builds/* + metro + app prepare (from cli)
@delacour/warden-core         golden, sims, affected, batch (what remains; thin)
@delacour/warden-driver       Driver contract, errors, refs, settle, geometry, typing, observation-cache,
                              trace/span, ./testing (FakeDriver)
@delacour/warden-driver-ios   ios/* + locate-helper (warden-simd)
@delacour/warden-driver-android android/* + uiad dex
@delacour/warden-screen       screen/* + expect/matchers (runner-free)
@delacour/warden-devtools     devtools/* (CDP, console, network, tree)
@delacour/warden-flows        flows/* (schema, record, replay, export)
@delacour/warden-e2e          runner only: session, env, preload, runner/*, expect(bun:test), fixtures
@delacour/warden-sdk  (NEW)   createWardenClient facade + ./ai-sdk + ./plugins + ./contracts
apps/cli                      thin presentation over the SDK (dogfood)
```

### Public SDK shape (target)
```ts
import { createWardenClient, isWardenError } from "@delacour/warden-sdk";

await using warden = createWardenClient({ label: "qa-ios", lockPolicy: "wait" }); // "wait" | "reject"

const [lease] = await warden.leases.claim({ platform: "ios", profile: "iphone-17-pro", count: 1 });
await warden.apps.ensure({ lease, project: "." });               // fingerprint build cache → install

await using session = await warden.sessions.open({ lease, app: "com.acme.app" });
await session.apps.open();
const snap = await session.capture.snapshot({ interactiveOnly: true }); // refs @e1…
await session.interactions.fill({ selector: "id=email", text: "a@b.co" });
await session.interactions.press({ ref: "@e3" });
await session.capture.screenshot({ path: "out.png", scale: 0.5 });
const logs = await session.devtools.console({ since: snap.takenAt });
// leaving scope: session closes, lease released (Symbol.asyncDispose)
```

Namespaces:

| Namespace | Methods |
|---|---|
| `client.devices` | `list`, `inventory`, `capacity` |
| `client.leases` | `claim`, `list`, `heartbeat`, `release`, `check` |
| `client.ports` | `claim`, `release` |
| `client.apps` | `ensure`, `install`, `builds.list`/`prune` |
| `client.metro` | `start`, `stop`, `status` |
| `client.sessions` | `open`, `end` |
| `session.apps` | `open`, `close`, `restart`, `reinstall`, `clearData` |
| `session.capture` | `snapshot`, `screenshot`, `video.start`/`stop` |
| `session.interactions` | `press`, `longPress`, `fill`, `type`, `key`, `swipe`, `scroll`, `pinch`, `rotate`, `gesture` |
| `session.query` | `find`, `wait`, `is`, `get` |
| `session.device` | `home`, `back`, `alert`, `orientation`, `appearance`, `clipboard`, `openUrl` |
| `session.devtools` | `eval`, `console`, `network`, `tree`, `reload` |
| `session.flows` | `record`, `replay`, `export` |
| `session.locator(sel)` | escape hatch to the full `Locator` API |

Every call:
- accepts `{ signal?: AbortSignal }`
- throws `WardenError` with `code`, `message`, `hint?`, `details`, `retryable`, `dispatched: "no" | "unknown" | "yes"`, carried over from agent-device's retry semantics

Internals stay `Result`-based. The facade unwraps once.

## Waves (parallel agents)
- **W1:** WSDK-0, WSDK-1
- **W2:** WSDK-2 ∥ WSDK-4
- **W3:** WSDK-3 ∥ WSDK-5
- **W4:** WSDK-6
- **W5:** WSDK-7
- **W6:** WSDK-8 ∥ WSDK-9 ∥ WSDK-10
- **W7:** WSDK-11

Each phase is one PR off `main`. TDD (`bun test <path>`), then `bun run typecheck && bun run check && bun run test`, then `bun run signoff`. Never bare `gh signoff`. No barrels; import from source.

---

## WSDK-0 — 📝 docs: SDK contract + ADR
**Goal:** Freeze the public surface before moving code, so later phases have a target.

**Do:**
1. Write `docs/plans/wsdk-sdk.md`: a copy of this plan plus an ADR covering:
   - throw vs Result at the boundary
   - Bun-only for v1
   - one bundled public package (internal splits stay private)
   - store schema compatibility
2. Create `packages/sdk` (`@delacour/warden-sdk`, private) with `src/sdk.types.ts`.
   - It holds types only: `WardenClientOptions`, every namespace interface above, `WardenErrorCode`, `Session`, `Lease`, `SnapshotResult` (`ElementJson[]` with refs), and `LockPolicy`.
   - Reuse the existing types where they fit: `Snapshot`/`Element`/`Role` from `driver.types.ts`, `Lease`/`Platform` from `core/src/types.ts`, `ElementJson` from `apps/cli/src/agent-ui/snapshot.ts`, `UiError` codes from `apps/cli/src/agent-ui/output.ts`.
3. Add an API report check: `@microsoft/api-extractor`, or a `tsc --emitDeclarationOnly` snapshot test.
   - Commit `packages/sdk/api/warden-sdk.api.md`.
   - CI fails on an unreviewed surface change.

**Accept:** `bun run typecheck` passes. The api report is committed. The ADR is merged.

## WSDK-1 — ♻️ refactor: typed errors + WardenHost
**Goal:** One error union and one host deps type, which every later package uses.

**Do:**
1. Add to `packages/types/src/error.ts`:
   - `WardenErrorCode`, a string-literal union seeded from `UiError` codes (`usage`, `failed`, `lease_*`, `engine_unavailable`, `devtools_unavailable`, `stale_ref`, `interrupted`), plus `claim_aborted`, `probe_timeout`, `capacity_exhausted`, `device_busy`, `not_found`, `build_failed`, `config_invalid`
   - `WardenError` = `{code, message, hint?, details?, retryable?}`
   - `wardenErr(code, message, extra?)` returning an `ErrorResult<WardenError>`
   - Tests colocated.
2. Add `packages/types/src/host.ts`:
   - `WardenHost` = `{env, cwd, now, exec, sleep, pidAlive, log?: (e: WardenLogEvent) => void, home: string}`
   - `WardenLogEvent` is a discriminated union (`{kind:"progress"|"warn"|"debug", …}`), so the CLI renders spinners from events.
3. Convert the string-compared errors first:
   - `CLAIM_ABORTED` (`core/src/claim.ts`, `apps/cli/src/lease-session.ts:431`)
   - `isProbeTimeout` (`core/src/providers/health.ts`)
   - the `"claim: "` quarantine prefix
   - Leave the remaining `err(string)` calls for each package split to convert. Track progress with `rg "err\(\"" packages/core | wc -l`.
4. Remove the `= process.env` defaults in `store.wardenHome`, `builds/config.findWardenConfig`, `affected.findSuite` and `owner.currentOwner`. Callers pass `host.env`.

**Accept:** No string comparison on error text remains (`rg "\.error (===|\.includes)"` is clean). All tests pass.

## WSDK-2 — ♻️ refactor: break core cluster cycles
**Goal:** Make the core clusters splittable without package cycles.

**Do:**
1. Move every zod schema into `packages/core/src/config/`:
   - `builds/config.schema`, `affected/affected.schema`, `batch/preset.schema`, `builds/app-option.schema`, `builds/eas.schema`
   - plus `builds/define-config.ts`
   - Nothing in `config/` may import outside it. Enforce with a test that scans import specifiers.
2. Make `parsePortSpec` pure and move it to `ports-spec.ts`, so `batch/preset.schema` stops importing `ports.ts` (and with it the store and `node:net`).
3. Move `isGoldenName` and its hash into `providers/golden-name.ts` (leaf). `providers/ios.ts` stops importing `golden/golden`.
4. Move `listAllSims` (`sims/list.ts`) so that `golden/golden` no longer imports `sims`. The pure `sims/rules` → `golden-name` direction is fine.
5. Move `androidTools` into `providers/android-tools.ts` (leaf). `builds/install` and the e2e drivers import only that.
6. Add `scripts/check-cycles.ts`, a cluster-level import graph check, and wire it into `bun run check`.

**Accept:** `check-cycles` reports 0 cluster cycles. No behaviour change. All tests pass.

## WSDK-3 — ♻️ refactor: split core into packages
**Depends on:** WSDK-1, WSDK-2.

**Do:** For each new package, follow the `AGENTS.md` "Adding a package" checklist: `package.json` with `fmt`/`lint`/`check`/`typecheck`/`test`, a tsconfig extending base, `biome.jsonc` extending `//`.

Packages:
- `warden-runtime`: `exec`, `git-facts` (drop the module-level `sharedGitFacts`; hold the cache on the host), plus `sleep`/`hash` seams
- `warden-store`: `types`, `liveness`, `store`
  - `store` keeps ownership of every migration
  - `builds/cache` and `prune` raw SQL become `Store` methods, or a `BuildsTable` helper in the store
- `warden-config`: `core/src/config/*` from WSDK-2
- `warden-providers`: `providers/*`
- `warden-leasing`: `allocate`, `queue`, `capacity`, `host`, `claim`, `room`, `ports`, `ports-spec`, `owner`, `inventory`, `shutdown-policy`, `headless`
- `warden-builds`: `builds/*`
- `warden-core` keeps `golden`, `sims`, `affected`, `batch`

Rules for every package:
- `exports` is a curated map. No `"./*"`.
- Test helpers (`*.testing.ts`, `*.fixture.ts`) go under a `./testing` subpath.
- Update every import in `apps/cli`, `packages/e2e` and `packages/e2e-bench` (about 61 files in cli). Use codemods (`sed`/`ast-grep`), not hand edits.
- Convert each package's `err(string)` to `wardenErr(code, …)` as it moves.

**Accept:** turbo builds the graph without cycles. `bun run test` passes. `bun run cli:link && warden claim ios --json && warden release --mine` works.

## WSDK-4 — ♻️ refactor: e2e layering prerequisites
Parallel with WSDK-2. Touches only `packages/e2e`, plus `apps/cli` import fixes.

**Do:**
1. Move `runner/span.ts` and the `TraceEvent` type (`runner/trace.ts`) into `src/trace/`, below the driver. `driver/traced-driver.ts` imports from `trace/`.
2. Pass `DEFAULT_ASSERTION_TIMEOUT_MS` in through `ScreenHost.env`. `screen/context.ts` stops importing `env.ts`.
3. Replace `openDriver(env: E2eEnv)` with `openDriver({platform, id, appId?, host, ios?: {simdPath?, helperDir?, socketPath?}, android?: {uiad?, setText?}})`.
   - Keep an `openDriverFromEnv(env)` shim for the runner.
   - `locate-helper.ts`, `android-state.ts` and `field.ts` stop reading `process.env`. Values come from options.
   - Search order and errors in `locate-helper` are unchanged.
4. Refactor `app.ts` and `device.ts`:
   - `createApp({driver, appId, appPath?, launchArgs?, artifactsDir, log?})`
   - `createDevice({driver, artifactsDir, …})`
   - Neither takes `E2eEnv` or `FixtureSession` any more. `fixtures.ts` adapts.
5. Make `session.ts` the only `globalThis` user, documented in `packages/e2e/AGENTS.md`.
6. Update `docs/plans/wdn-e2e.md`, because `driver.types.ts` and `env.ts` are marked frozen there. Record the move.

**Accept:** A new test, `packages/e2e/src/standalone.test.ts`, opens a `FakeDriver` (`driver/driver.testing.ts`) and calls `createScreen` + `createDevice` + `createApp` with no env vars and no `bun:test` runner hooks. All suites pass. `warden e2e example` is green on a claimed sim (use `warden`, never argent).

## WSDK-5 — ♻️ refactor: split e2e into packages
**Depends on:** WSDK-3 (`runtime`/`store` imports), WSDK-4.

**Do:**
1. Create these packages, each with a curated `exports` map and `./testing` for fakes:
   - `warden-driver`
   - `warden-driver-ios` (moves `native/ios`, `locate-helper`)
   - `warden-driver-android` (moves `native/android`, `uiad-dex.generated.ts`)
   - `warden-screen`
   - `warden-devtools`
   - `warden-flows`
2. Leave the runner in `warden-e2e`.
3. Repoint the ~45 deep imports.
4. Repoint the `apps/cli/src/npm/e2e-bundle.ts` bundle inputs. The published `@delacour/warden-e2e` surface (`index.ts`, `preload`) must be byte-for-byte API-compatible; the api report diff is empty.
5. Move the native build scripts with their package, and update `scripts/signoff/signoff-checks.ts` path gates (`native` check). Update the drift test.

**Accept:**
- `bun run build:npm` (cli) produces an identical `@delacour/warden-e2e` `.d.ts`.
- `warden e2e example` is green on iOS and Android.
- signoff `native` triggers on the new paths.

**As landed (decisions):**
- Seven new private packages, each with curated `exports` and fakes under `./testing/<name>`: `warden-driver` (also owns `trace/`, `e2e-error.ts`, `alert-buttons.ts` and `helper/simd-protocol` + `simd-transport`, which both drivers share), `warden-driver-ios`, `warden-driver-android`, `warden-screen` (with the runner-free `matchers.ts`), `warden-devtools`, `warden-flows`, `warden-device`.
- `warden-device` holds `openDriver` (`open.ts`, the one module that needs both drivers) plus `createApp` / `createDevice` / device link / alert reader / traced device / `fixture-session`, because the SDK (WSDK-7) needs them without the runner. `openDriverFromEnv` and the default driver factory stay in `warden-e2e` (`open-from-env.ts`): they read `E2eEnv` and the session.
- `warden-e2e` keeps `index`, `env`, `session`, `preload`, `fixtures`, `runner/*`, `expect/expect.ts`, and its exports map is `.`, `./preload`, `./env`, `./runner/results`, `./runner/trace`.
- Native moved with its owner: `packages/driver-ios/native` (Swift, `native:deps`, `native:build`, `native/dist`) and `packages/driver-android/native` (Java, `android:build`, `android:emit`). The hand-run smoke scripts (`smoke`, `smoke-android`, `screen-cost`) cross layers and live in `packages/e2e/scripts`.
- `scripts/cycles` no longer lists `packages/e2e` as a pending cluster cycle; it also fails on an undeclared sibling import, so each package declares what it imports.
- Published `@delacour/warden-e2e` API: the transitive declaration closure of `index.ts` (354 declarations) and `preload.d.ts` are byte-identical before and after.

## WSDK-6 — ♻️ refactor: lift CLI business logic into packages
**Depends on:** WSDK-3, WSDK-5.

Move each piece with its tests:

| CLI file | Destination | Change |
|---|---|---|
| `lease-session.ts` | `warden-leasing/src/session.ts` | Drop commander helpers (`withLeaseOptions` stays in the CLI); replace `Spinner`/`ctx.err` with `host.log` events |
| `device-lease.ts`, `lease-select.ts`, `device-shutdown.ts`, `device-state.ts`, `elastic.ts`, `bounded.ts` | `warden-leasing` | as-is |
| `claim-flags.ts` | split | `parseClaimFlags` + `withClaimOptions` stay in the CLI; `claimWithFlags` → `warden-leasing/claim-request.ts` with a typed `ClaimRequest`. The platform prompt (`ctx.ui.select`) stays in the CLI |
| `providers.ts`, `golden-deps.ts`, `capacity-deps.ts` | `warden-leasing/host-deps.ts` | Builds `ProviderDeps`/`CapacityDeps` from a `WardenHost` |
| `metro.ts` | `warden-builds/metro.ts` | |
| `commands/app.ts` `prepareApp`/`ensurePreparedApp`/`ensureAppFor` | `warden-builds/prepare.ts` | |
| `commands/dev.ts` | `warden-builds/dev-session.ts` | Extract `devSession(host, req) → {udid, port, metroUrl, leaseIds}`; output stays in the command |

For agent-ui:
1. Each `uiX(ctx, deps, words, opts) → number` becomes a typed op `uiOps.press(session, params) → AsyncResult<PressResult, WardenError>`, plus a thin CLI adapter that parses words and prints `UiJson`.
2. Put the ops in `packages/sdk/src/ops/*` (they become the SDK's interaction engine).
3. `target.ts`, refs/generation, `snapshot.ts`, `query.ts`, `scroll.ts`, `gestures.ts`, `controls.ts`, `video.ts`, `devtools-cli.ts` logic and `flows-command.ts` logic all move.
4. The file-backed generation/state (`agent-ui/state.ts`) becomes a pluggable `RefStore`: an in-memory one for the SDK, a file one for the CLI (keeps cross-process `@eN` refs working).

**Stays in the CLI:** `e2e-runtime.ts` (`Bun.embeddedFiles`), `autogc`, `skill`, `hooks`, `update`, `npm`, `sim-windows` (re-export only), `batch` TUI.

**Accept:**
- Golden JSON tests: for each `warden ui` subcommand, `--json` output is the same before and after. Snapshot the existing output first in `apps/cli/src/agent-ui/__snapshots__`.
- `apps/cli` has no logic file over ~150 LOC except `batch.ts` and the TUI.

## WSDK-7 — ✨ feat: `@delacour/warden-sdk` client
**Depends on:** WSDK-6.

**Do:**
1. Implement `createWardenClient(options)` in `packages/sdk/src/client.ts`, against the `sdk.types.ts` contract from WSDK-0.
2. Options:
   - `label?`, `owner?`
   - `lockPolicy: "wait" | "reject"` (maps to the claim queue vs fail-fast)
   - `priority?`, `home?` (`WARDEN_HOME`)
   - `host?: Partial<WardenHost>` (inject for tests)
   - `signal?`, `onEvent?: (e: WardenLogEvent) => void`
3. The client holds the store and host. `sessions.open({lease | udid | serial, app?})`:
   - opens the driver via `openDriver` (iOS: `helper.connectHelper` from WSDK-6 → resident `warden-simd`)
   - wraps it in `cacheObservations` + `traceDriver`
   - holds an in-memory `RefStore`
4. Ownership: never shut down, erase or install on a device warden didn't create or lease. `sessions.open` calls `ensureCallerLease` first.
5. Lifecycle: `Symbol.asyncDispose` on the client and the session. The client releases the leases it claimed, using `releaseDevices` + `shutdownReleasedDevices` per policy. Use the heartbeat from `holdLeases` while the client is alive (an unref'd timer).
6. Boundary: unwrap `Result`s into a thrown `WardenError` class (`code`, `hint`, `details`, `retryable`, `dispatched`). Export `isWardenError`.
7. AbortSignal is threaded into exec/claim waits (`claim.ts` already has `CLAIM_ABORTED`).
8. Tests:
   - Unit tests with FakeDriver plus a temp `WARDEN_HOME`.
   - An integration test that skips unless `WARDEN_SDK_DEVICE=1`: claim a sim via `warden claim ios --json`, open Settings, snapshot, press, screenshot, release.

**Accept:**
- The example in "Public SDK shape" runs verbatim as `packages/sdk/examples/basic.ts` on a warden-claimed sim.
- The api report matches WSDK-0 (diffs reviewed).

## WSDK-8 — ♻️ refactor: CLI dogfoods the SDK
**Do:**
1. `warden ui *`, `claim`, `release`, `ls`, `port`, `app`, `dev` call the SDK client (or the packages under it) instead of internal functions.
2. Add Zod schemas for every `--json` output, in `packages/sdk/src/contracts/*.schema.ts`: `claimedJson`, ls, gc, dev, check, `DeviceRow`, `UiJson`, `E2eReport`. The CLI validates in tests, and the SDK exports them via `@delacour/warden-sdk/contracts`, so shell integrators get typed parsers.

**Accept:** WSDK-6 golden JSON tests are still green. Startup time doesn't regress more than 10% (`apps/cli/src/startup.test.ts`, lazy imports kept).

## WSDK-9 — ✨ feat: `@delacour/warden-sdk/ai-sdk` tools adapter
**Do:**
1. Add `createWardenTools({ client?, session?, platform, set: "core" | "all", approval?: Partial<Record<ToolName, "user-approval">> })` → `{ tools, client, session }` for Vercel AI SDK v5 (`tool({ inputSchema: z.object(...), execute })`).
2. Core set: `open`, `close`, `snapshot`, `press`, `fill`, `type`, `get`, `is`, `find`, `wait`, `back`, `scroll`, `swipe`, `alert`, `screenshot`, `logs`.
   `all` adds: `claim`, `release`, `devices`, `install`, `metro`, `eval`, `network`, `record`/`replay`.
3. Tool errors return `{ok:false, error:{code, message, hint}}` instead of throwing, so the model can recover. A `stale_ref` hint tells it to re-snapshot.
4. Snapshot output is compact text (reuse `renderSnapshot` from `warden-screen`) with `@eN` refs, to limit tokens.
5. Make `ai` an optional peer dependency. Tool input schemas live in `ai-sdk/tools.schema.ts` and are reusable by an MCP server later.
6. Add `packages/sdk/examples/agent.ts` (`ToolLoopAgent`) and a test with a mocked model (`ai/test` `MockLanguageModelV2`).

**Accept:** The mock-model test drives open→snapshot→press over FakeDriver. The example runs on a claimed sim.

## WSDK-10 — ✨ feat: integration extension points (`./plugins`)
**Do:**
1. Device provider plugins:
   - Export `DeviceProvider` + `ProviderDeps` types from `@delacour/warden-sdk/plugins`.
   - Add `defineProvider({ name, platform, setup(host) → DeviceProvider & { driver?: (id) => Promise<Driver> }, dispose? })` for cloud/physical device farms.
   - Register via `createWardenClient({ providers: [...] })` or `warden.config.ts` `providers`.
   - Bundled `ios`/`android` win on a name clash (`duplicate_provider` error). Reserve `ios`, `android`, `cloud`.
2. Driver plugins: export the `Driver` contract + `warden-driver/testing` conformance suite (`runDriverConformance(makeDriver)`), so third-party drivers prove parity.
3. Events: `client.on("lease:claimed" | "lease:released" | "device:booted" | "session:opened" | "action", …)`, a typed discriminated union. It reuses `WardenLogEvent`.
4. Experimental marker: `apiVersion: 1` on plugin factories. Document the version policy in `apps/docs/content/docs/sdk/plugins.mdx`.

**Accept:** An example plugin (`packages/sdk/examples/fake-provider.ts`) passes the conformance suite and can be claimed through the client.

## WSDK-11 — 🔧 chore: publish + docs
**Do:**
1. `apps/cli/scripts/npm-packages.ts` + `src/npm/manifests.ts`: add an `SdkManifest` for `@delacour/warden-sdk`.
   - Bundled ESM (`bun build --target bun`) with `.d.ts` (reuse `npm/declarations.ts`).
   - Exports `.`, `./ai-sdk`, `./plugins`, `./contracts`.
   - `engines.bun`; `zod` as a dependency; `ai` as an optional peer.
   - Exact version lock-step with `@delacour/warden`.
   - `optionalDependencies` on `@delacour/warden-<target>` so `warden-simd` is available, resolved via its `bin`.
2. Store compatibility: `client` reads the store `schema_version` and fails with `store_incompatible` (hint: `warden update`) when it is newer than it supports. Add a test.
3. Lint the published package with `attw` (are-the-types-wrong) and `publint`.
4. Docs in `apps/docs/content/docs/sdk/`: `index`, `client-api`, `ai-sdk`, `build-an-integration`, `plugins`, `contracts`. Use `twoslash`-style examples checked by typecheck.
5. Update the `AGENTS.md` published-packages rule to include `@delacour/warden-sdk`.
6. Update the warden skill (`apps/cli/skills/warden/**`) with an SDK section.

**Accept:** `bun run release --dry-run` stages 4 + N packages. `attw` is clean. The docs build. Installing from a packed tarball runs `examples/basic.ts` in a fresh repo.

---

## Best-practice notes (adopt)
- Throw at the public boundary, `Result` inside. TS consumers expect throws; `dispatched` tells an integrator whether a retry is safe.
- `await using` / `Symbol.asyncDispose` so leases can't leak. A lease is an exclusive machine resource.
- Every call takes `AbortSignal`. Agents get cancelled a lot.
- An API report plus semver-by-surface means integrators can trust minor bumps.
- A conformance suite for plugins makes the third-party driver/provider contract enforceable.
- Bun-only v1 is honest; it matches `@delacour/warden-e2e`. A Node port needs `node:sqlite` + spawn seams (already partly injectable via `WardenHost`).

---

## ADR — WSDK-0 (2026-10-24)

### ADR-1: one bundled public package
- **Decision:** only `@delacour/warden-sdk` is published for SDK consumers. Every split package (`runtime`, `store`, `config`, `providers`, `leasing`, `builds`, `driver*`, `screen`, `devtools`, `flows`) stays `private` in the workspace and is inlined at build time.
- **Why:** one semver surface to review, no lock-step matrix of ~14 npm packages, internal moves never break integrators.
- **Cost:** bundle size; types must be reachable from the entries (same rule as `@delacour/warden-e2e`).

### ADR-2: Bun-only v1
- **Decision:** `engines.bun`; `bun:sqlite`, `Bun.spawn`, `Bun.connect` stay.
- **Why:** matches `@delacour/warden-e2e`; a Node port needs `node:sqlite` + spawn seams, deferred until `WardenHost` covers them.

### ADR-3: throw `WardenError` at the boundary, `Result` internal
- **Decision:** internals return `Result` / `AsyncResult`; the SDK facade unwraps once and throws a `WardenError` (`code`, `message`, `hint?`, `details?`, `retryable?`, `dispatched`). `WardenErrorShape` in `sdk.types.ts` is the wire/JSON shape.
- **Why:** TS consumers expect throws and `await using`; `dispatched: "no" | "unknown" | "yes"` tells an integrator whether a retry is safe.
- **Codes:** every existing `UiErrorCode` verbatim plus new lease/claim/build/store codes. Append-only within a major.

### ADR-4: store schema compatibility
- **Decision:** the sqlite store keeps a `schema_version`. `createWardenClient` reads it; newer than the SDK supports fails with `store_incompatible` (hint: `warden update`). Older is migrated forward by the store as today.
- **Why:** the CLI and any SDK embedder share one machine-wide store; a stale SDK must not corrupt it.

### ADR-5: API surface is a reviewed artifact
- `packages/sdk/src/sdk.types.ts` is the frozen contract (types only). `packages/sdk/api/warden-sdk.api.d.ts` is its emitted declaration; `api-report.test.ts` fails on drift. Update with `UPDATE_API_REPORT=1 bun test packages/sdk` and review the diff.

## Status (WSDK-11)

All twelve phases are implemented on `feature/warden-typescript-sdk`. Nothing is published to npm yet; the first release goes through `bun run release <version>`.

| Phase | State |
|---|---|
| WSDK-0 contract + ADR | done: `sdk.types.ts`, `api/*.api.d.ts`, `api-report.test.ts` |
| WSDK-1 typed errors + `WardenHost` | done (the `process.env` defaults are gone); `err(string)` remains elsewhere, see deferred |
| WSDK-2 cluster cycles | done: `scripts/check-cycles.ts` in `bun run check`; the apps/cli cluster has an allowlist, see deferred |
| WSDK-3 core split | done: runtime, store, config, providers, leasing, builds |
| WSDK-4 e2e layering | done: `standalone.test.ts` |
| WSDK-5 e2e split | done: driver, driver-ios, driver-android, screen, devtools, flows, device |
| WSDK-6 lift CLI logic | done: ops in `packages/sdk/src/ops`, `RefStore`, golden `--json` snapshots |
| WSDK-7 client | done: `createWardenClient`, sessions, `await using`, `AbortSignal` |
| WSDK-8 CLI dogfood + contracts | done: zod schema per `--json` output; the CLI shares the engine functions, not the client (the client would load zod and drivers on every start) |
| WSDK-9 `ai-sdk` | done: `createWardenTools`, `core` (16) and `all` (25) sets, mock-model test |
| WSDK-10 plugins | done: `defineProvider`, conformance suite, typed events, `fake-provider` example |
| WSDK-11 publish + docs | done, below |

### WSDK-11 delivered

- **`@delacour/warden-sdk` package.** `sdkManifest` + `stageSdk` (`apps/cli/src/npm/`): bundled ESM (`bun build --target bun`, workspace inlined, `zod` + `ai` external), tsc-emitted `.d.ts` with `.js` relative specifiers so it resolves under node16 and bundler, `engines.bun >=1.3`, `zod` dependency, `ai` optional peer, exact `optionalDependencies` on the four platform packages, lock-step version. Exports: `.`, `./ai-sdk`, `./ai-sdk/tools.schema`, `./plugins`, `./plugins/conformance`, `./contracts`. Hooked into `build:npm` (and `build:npm:sdk` / `--sdk-only` for just the SDK), `release.ts` (version file and publish order) and the release workflow.
- **`lease-view` is not public.** It is CLI plumbing shared with the client; it stays a workspace-internal export.
- **Per-contract subpaths dropped.** `./contracts` is the one facade; per-file subpaths would add package-map and declaration weight for no consumer need.
- **Helper resolution.** `locate-helper` gains a last rung: `bin/warden-simd` of the installed `@delacour/warden-<target>` package (`source: "platform-package"`), so an SDK consumer on Apple Silicon needs no separate helper install.
- **Store compatibility.** The store version is SQLite's `PRAGMA user_version` (the migration count), not a `schema_version` meta row as ADR-4 sketched. The client refuses a newer store with `store_incompatible` (hint `warden update`).
- **Package lint.** `sdk-stage.test.ts` stages the real package and runs bundle-safety, `publint --strict` and `attw --profile esm-only` (node10 and CommonJS are ignored on purpose: ESM-only, Bun-only).
- **Docs.** `apps/docs/content/docs/sdk/`: `index`, `client-api`, `ai-sdk`, `build-an-integration`, `plugins`, `contracts`. Code samples are `packages/sdk/examples/*.ts`, typechecked with the package.

### WSDX (after the develop rebase)

The branch was squash-rebased onto `develop` (per-phase history on `backup/wsdk-pre-rebase`); the flow recorder and `packages/flows` were dropped with develop's specs rename. Plan: `wsdx-sdk-extend.md`.

| Phase | Delivered |
|---|---|
| WSDX-1 | `session.record.*` on `packages/sdk/src/ops/authoring`; `warden ui record` is an adapter; `record_*` ai-sdk tools; `stop()` verifies through `warden e2e` by default |
| WSDX-2 | `session.perf.*`, `warden.perf.{ls,report}`; perf engine in `packages/sdk/src/ops/perf`; `perf_*` tools; perf contracts |
| WSDX-3 | `warden.specs.{list,affected,run}`; `cliCommand` option |
| WSDX-4 | `devtools.route()`, `devtools.nativeLogs()`, HID recovery in SDK iOS sessions, `claim({ shared })`, `devices.viewer()` / `arrange()` |
| WSDX-5 | `leases.provider` column, `providers` in `warden.config.ts`, plugin devices in `devices.*`, cross-process plugin sessions, `runProviderConformance` |
| WSDX-6 | typed errors in providers/claim/ports/ensure (provider plugin API now returns `WardenError`), provider/shared stamped inside the claim transaction, screenshot image part, a schema per `warden ui` result, `route` in the core tool set |

### Deferred

- **Record verify runs on an `e2e`-claimed device**, not the session's lease: `warden e2e` has no `--udid`/`--lease` flag yet.
- **Specs run progress** is stderr lines only; the CLI has no structured event stream.
- **Perf CLI-only:** `doctor`, `diff`, `record`, `react`, `native`, `query`, `metrics --watch`.
- **`uiResultSchemaFor`** does not map `route`, `perf *` or `arrange` (their schemas exist).
- **SDK recordings are per process**: `warden ui record` in another process does not see them.
- **iOS device runs on Xcode 27.1.** `warden-simd` fails at load with a dyld error (`AccessibilityPlatformTranslationStub`), so the end-to-end iOS check of the SDK could not run on that toolchain; Android and the fake-driver tests are unaffected.
- **Cluster cycle allowlist** in `scripts/cycles/check-cycles.ts`: apps/cli, packages/perf, packages/e2e-bench.
- **Node support.** Bun-only by ADR-2.
