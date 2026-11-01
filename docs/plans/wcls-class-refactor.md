# WCLS: class-based modules

Plan ID **WCLS**. Every function in `packages/*/src` and `apps/cli/src` lives in a class.

**Status: done.** `bun run check:classes` reports 0, Biome reports no warnings, and the plugin runs at severity `error` (WCLS-9).

Enforced by `packages/biome-config/plugins/no-loose-function.grit`. `bun run check:classes` prints a per-package count of top-level functions (`--strict` exits 1 while any remain).

## Scope

**In scope:** `packages/*/src/**` and `apps/cli/src/**`.

**Out of scope** (the plugin skips these):
- `*.test.ts(x)`
- `*.script.ts`, the functions serialised into the app runtime with `fn.toString()`
- `*.d.ts`
- `packages/e2e-bench`
- `**/native/**`
- `apps/docs`, `apps/example`, `scripts/`

## Rules

1. **One primary class per file**, named after the file's domain.
   - Example: `claim.ts` → `ClaimService`, `android-parse.ts` → `AndroidParser`, `gc.ts` → `GcCommand`.
   - File names stay kebab-case.
   - Small private helper classes in the same file are fine.
2. **Stateful or side-effect code is an instance class with constructor dependency injection.** This covers store, exec, providers, drivers, leasing, builds, sessions, ops and CLI commands.
   - Dependencies arrive as `constructor(private readonly deps: XDeps) {}`.
   - Reuse the existing injected shapes: `exec`, clock, `WardenHost`, `Store`, `LeaseHost`, `AppHost`.
   - A former module-level `let` or cache becomes an instance field.
3. **Pure helpers** (parsers, formatters, argv builders, mappers) are an instance class plus one exported shared singleton: `export class AndroidParser { … }` and `export const androidParser = new AndroidParser();`. Callers use the singleton; tests may `new` it.
   - No static-only classes, because the recommended `complexity/noStaticOnlyClass` rule stays on.
4. **Inheritance only where 2 or more siblings share shape**, one level deep unless the code already has more. Use an abstract base with the shared logic plus `protected abstract` hooks. Planned bases:
   - provider: `DeviceProvider` → ios / android / plugin (added as `BaseDeviceProvider`)
   - drivers: a shared base over ios, android and physical device
   - builds: `BuildStrategy` → eas / local / repack
   - SDK: `Op<P, R>` with `run(session, params): AsyncResult<OpDone<R>, WardenError>`
   - CLI: a `Command` base around `defineCommand`
   - perf: a `Collector` base

   Don't invent hierarchies for single implementations.
5. **Not converted:**
   - Types, interfaces and discriminated unions.
   - zod schemas, `as const` tables and constants.
   - `*.script.ts`.
   - Published wrappers. The plugin allowlists these names: `createWardenClient`, `createWardenTools`, `defineConfig`, `defineProvider`, `defineCommand`, `test`, `describe`, `expect`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`.
   - Callbacks inside methods: arrow functions passed to `.map`, `on(...)` and so on are fine.
6. **Behaviour is unchanged:**
   - `Result` / `AsyncResult` and `WardenError` stay.
   - CLI `--json` output, the help snapshot, the ui goldens and the SDK API reports (`packages/sdk/api/*.api.d.ts`) must not change. If the API report diff is non-empty, a public type leaked, so fix the code, not the report.
   - No changeset is needed for this refactor.
7. **Lazy imports stay lazy.** Write `const { GcCommand } = await import("./commands/gc")` and then `new GcCommand(deps)`. The `apps/cli/src/startup.test.ts` budget must hold.
8. **Methods:**
   - Use `private` for anything not used outside the class.
   - Keep cognitive complexity ≤ 15 per method; split into private methods, never into module functions.
   - Methods that are passed as callbacks become arrow-function class properties (`private readonly onLine = (line: string) => {…}`), or are bound in the constructor.
9. **Tests:**
   - Update existing tests to `new X(fakeDeps)` or the singleton.
   - Write a test first for each new base class.
   - `mock.module` on a function export becomes constructor injection.
   - `*.testing.ts` fakes become classes too.

## Worked examples

### Pure helper → class + singleton

```ts
// before
export function parseDumpsys(text: string): Window[] { … }
export function focusedWindow(text: string): string | undefined { … }

// after
export class DumpsysParser {
	windows(text: string): Window[] { … }
	focused(text: string): string | undefined { … }
}
export const dumpsysParser = new DumpsysParser();
```

### Side effects → constructor DI

```ts
// before
export async function shutdownIdle(store: Store, exec: Exec, now: () => number): AsyncResult<number, WardenError> { … }

// after
export type IdleShutdownDeps = { store: Store; exec: Exec; now: () => number };
export class IdleShutdown {
	constructor(private readonly deps: IdleShutdownDeps) {}
	async run(): AsyncResult<number, WardenError> { … this.deps.exec(…) … }
}
```

### Siblings → abstract base

```ts
export abstract class Op<P, R> {
	abstract readonly name: string;
	async run(session: OpSession, params: P): AsyncResult<OpDone<R>, WardenError> {
		const target = await this.resolve(session, params);
		if (!target.ok) return target;
		return this.execute(session, params, target.value);
	}
	protected abstract execute(session: OpSession, params: P, target: Target): AsyncResult<OpDone<R>, WardenError>;
	protected resolve(session: OpSession, params: P): AsyncResult<Target, WardenError> { … }
}
export class PressOp extends Op<PressParams, PressResult> { readonly name = "press"; protected async execute(…) { … } }
export const pressOp = new PressOp();
```

### Public wrapper stays a function

```ts
export function createWardenClient(options: WardenClientOptions = {}, seams: ClientSeams = {}): WardenClient {
	return new WardenClientImpl(options, seams);
}
```

## Waves (dependency order; each agent owns one package and updates its call sites repo-wide)

| Phase | Packages |
|---|---|
| WCLS-2 | types, runtime, config, store |
| WCLS-3 | providers, leasing, builds |
| WCLS-4 | core, driver, devtools |
| WCLS-5 | driver-ios, driver-android, screen, perf |
| WCLS-6 | device, e2e |
| WCLS-7 | sdk: ops/*, plus client/session/ai-sdk/contracts |
| WCLS-8 | apps/cli: commands a–l, commands m–z, agent-ui + perf, the rest |
| WCLS-9 | Biome 0 warnings, plugin severity `error`, AGENTS.md |

## Done per package

- `bun run check:classes` shows 0 for the package.
- `bun run --cwd <pkg> typecheck` passes, and dependents typecheck.
- `bun test` passes for the package and for the dependents whose call sites changed.
- `bunx biome check <pkg>` reports 0 warnings.

## Outcome: bases added and skipped

Added (each has 2+ real siblings):
- `BaseDriver` (`packages/driver`), with `IosEngineBase` (`packages/driver-ios`) under it.
- `CliCommand` (`apps/cli/src/command.ts`), the base around `defineCommand`.
- `CaptureTask` (`apps/cli/src/perf/collector.ts`).
- `BaseDeviceProvider` (`packages/providers`).
- `ConditionProcessCommand` (`apps/cli/src/commands/condition-processes.ts`).

Planned but skipped:
- SDK `Op<P, R>`: the ops share only a signature, not logic, so a base adds nothing over the type.
- SDK perf `Collector`: no shared logic emerged, so a base would only be hooks.
- builds `BuildStrategy`: no shared logic emerged; eas, local and repack stay separate classes, orchestrated by `ensure.ts`.
- agent-ui `UiVerb`: the verb adapters differ in options, device handling and output, so a base would be all hooks.

Method names do not repeat their class name (`EasResolver.resolve`, `UiStatus.run`, `DevLogs.run`, `HotCommits.find`).
