# Plan WDN — `warden`: machine-wide device + port leasing for agents/users

## Context
Agents, Orca worktrees and other repos currently share iOS sims / Android emulators / Metro ports with no coordination. Salient's `run-ios.ts` reuses `salient-e2e-1..N` by name (`parallel-helpers.ts:48 planSims`) — two worktrees running e2e at once grab the same sims → flakes. Ports are only protected by a free-port scan (`run-ios.ts:188 pickPort`). Goal: one global CLI, `warden`, that owns a lease registry so a device/port in use by one agent/user/project is never handed to another. Built in the separate **warden** repo (Bun + Turbo scaffold, `@warden/*` scope), compiled to a standalone binary so any repo can use it.

Second goal: warden also owns **app build reuse**. It keys native builds by Expo fingerprint in a machine-wide cache, so a fresh workspace/branch reuses an installed app, a cached `.app`/`.apk`, or an EAS dev build. It builds locally only as a last resort, and always does so when the fingerprint is new.

Decisions (answered): name **warden**; iOS + Android; own impl on `xcrun simctl`/`adb`/`emulator` (baguette only as reference — its `lifetime --detach` idea, headless boot); compiled binary in `~/.local/bin`; default CoreSimulator set with `warden-<profile>-N` names; Claude PreToolUse hook auto-claims / denies if taken; ports leased in v1.

## WDN-0: set up the cowrie workspace and hand off to an agent
The target is the existing Orca workspace `~/orca/workspaces/warden/cowrie` (repo `delacournz/warden`, branch `feature/cowrie`). It sits at `20e6f7b`, the same commit as `feature/bun-monorepo-setup`, and contains only `README.md`. The Bun/Turbo scaffold is untracked in `~/orca/workspaces/warden/needlefish`, so it has to be copied across:
1. `rsync -a --exclude node_modules --exclude dist --exclude .git ~/orca/workspaces/warden/needlefish/ ~/orca/workspaces/warden/cowrie/`. This leaves needlefish untouched.
2. `mkdir -p cowrie/docs/plans && cp` this plan to `cowrie/docs/plans/wdn-warden-cli.md`. The agent treats this copy as the source of truth.
3. `cd cowrie && bun install && bun run typecheck && bun run check`.
4. Hand off with `orca terminal create --worktree path:/Users/chris/orca/workspaces/warden/cowrie --title warden-agent --command 'claude "Implement docs/plans/wdn-warden-cli.md phases WDN-1..WDN-7 in order, using parallel subagents per the wave plan. Read AGENTS.md first. TDD, bun test. Commit per phase (gitmoji, no Co-Authored-By); the first commit also adds the copied scaffold. Skip WDN-8 (monorepo follow-up)."' --json`.
5. Report the terminal handle to the user. Monitor it with `orca terminal read`.

## Architecture (warden repo: `packages/core` + `apps/cli`)
`packages/core` (`@warden/core`) = everything below except `cli.ts`/`commands/`/`hooks/`, which live in `apps/cli` (`@warden/cli`, bin `warden`). Follow warden `AGENTS.md`: `biome.jsonc` extends `//`, tsconfig extends `@warden/tsconfig/tsconfig.base.json`, errors as `Result`/`AsyncResult` from `@warden/types`, no barrels, file naming `{domain}.types.ts` etc.
```
src/
  cli.ts                 entry; node:util parseArgs; subcommand dispatch
  types.ts               discriminated unions (below)
  store.ts               bun:sqlite ~/.warden/warden.db (WAL; claims in BEGIN IMMEDIATE → atomic across processes)
  owner.ts               detect owner: Claude session id (hook stdin / CLAUDE_* env), Orca worktree, git toplevel+branch, pid, user tty, CI
  liveness.ts            lease alive = pid alive (kill 0) || heartbeat < ttl; pure
  allocate.ts            pure: (inventory, leases, request) → plan {reuse | create | boot | wait}
  providers/ios.ts       simctl list -j parse, create, boot (headless), bootstatus -b, shutdown, erase
  providers/android.ts   adb devices, emulator -list-avds, boot `-avd X -port <even> -no-window -read-only`, adb emu kill
  ports.ts               port lease in range + bind probe
  commands/{claim,release,run,ls,heartbeat,gc,port,check,install,doctor}.ts
  hooks/claude-pretool.ts  PreToolUse handler (stdin JSON → exit 0 / 2)
```
Types (no `any`):
- `Resource = { kind: "device"; platform: "ios" | "android"; id: string /*udid|serial*/; name: string } | { kind: "port"; port: number }`
- `Owner = { kind: "agent"; sessionId; cwd; repo?; worktree? } | { kind: "user"; pid; tty?; cwd } | { kind: "ci"; runId }`
- `Lease = { id; resource; owner; label?; acquiredAt; heartbeatAt; ttlMs; pid? }`

Rules:
- Booted device with **no lease and not warden-created** = foreign (user's Simulator.app / another tool) → never allocated unless `--adopt`.
- Stale lease (pid dead AND heartbeat expired) reclaimed on every claim + `warden gc`.
- Pool growth: create `warden-<profile>-N` when no free matching device, up to `--max` (default: cores/4, cap 4 — mirrors salient's heuristic, `parallel-helpers.ts:22`).
- Idle warden devices shut down by `gc` after idle timeout (default 20 min); never deleted.
- Port logic from `run-ios.ts:179-200` (`isPortFree`/`pickPort`) and sim parsing from `ios-helpers.ts:37 parseSimctlDevices` / `parallel-helpers.ts:48 planSims` ported in (copied from delacour-monorepo `apps/salient/app/scripts/e2e/`; salient keeps its copies until WDN-8).

CLI surface (all support `--json`):
- `warden claim ios|android [--profile iphone-17] [--runtime latest] [--count N] [--wait 10m] [--ttl 30m] [--label x]` → leases + udids, booted & ready
- `warden run ios --count 2 [--port 8091:20 --port 3208:20] -- <cmd>` → claim, export `WARDEN_UDIDS`, `WARDEN_PORT_0..`, heartbeat every 30 s, release on exit/SIGINT/SIGTERM. Primary integration for any repo's e2e script.
- `warden release <leaseId…> | --udid X | --mine | --session S [--shutdown]`
- `warden port claim --from 8091 --span 20` / `port release`
- `warden ls` (table: resource, state, owner, repo/worktree, age, heartbeat) · `warden check --udid X --session S` · `warden heartbeat <id>` · `warden gc` · `warden doctor`
- `warden app ensure ios|android [--project <dir>] [--lease id|--udid X] [--no-eas] [--no-build] [--json]` → `{ appPath, hash, source: installed|cache|eas|build, installed }` (see WDN-5)
- `warden app fingerprint` · `warden builds ls|prune [--max-size 20G]|import <app> --hash H` · `warden run … --app` = claim + ensure installed
- `warden install [--claude]` → copy binary to `~/.local/bin`, write skill + hooks (prints diff, asks confirm before touching `~/.claude/settings.json`)

## Phases (ID · depends on · parallel)
| ID | Title | Deps |
|---|---|---|
| WDN-0 | warden 0 - 🔧 chore: set up the cowrie workspace and hand off | — |
| WDN-1 | warden 1 - ✨ feat: package scaffold, types, sqlite store, liveness, allocate (TDD) | 0 |
| WDN-2 | warden 2 - ✨ feat: iOS provider + claim/release/run/ls/gc/check | 1 |
| WDN-3 | warden 3 - ✨ feat: Android provider | 1 (∥ 2) |
| WDN-4 | warden 4 - ✨ feat: ports (`warden port`, `run --port`) | 1 (∥ 2,3) |
| WDN-5 | warden 5 - ✨ feat: app build cache — fingerprint → cached build → EAS dev build → local build, + install-skip | 1,2 (∥ 3,4,6) |
| WDN-6 | warden 6 - ✨ feat: Claude hook + global skill + `warden install` | 2 |
| WDN-7 | warden 7 - 📝 docs: AGENTS.md + README (usage, install) | all |
| WDN-8 | warden 8 - ♻️ refactor(salient): run-ios + resolve-dev-build use warden — **follow-up in delacour-monorepo, not handed off** | 2,4 + binary installed |

Wave plan for subagents (disjoint files): wave A = WDN-1; wave B = WDN-2, WDN-3, WDN-4 in parallel; wave C = WDN-5, WDN-6 in parallel; WDN-7 last.

### WDN-1 detail
- `packages/core/package.json` `@warden/core` + `apps/cli/package.json` `@warden/cli` with `bin: { warden: ./src/cli.ts }`, scripts per warden AGENTS.md checklist (`fmt`/`lint`/`check`/`typecheck`/`test: bun test`); in apps/cli also `build: bun build --compile src/cli.ts --outfile dist/warden`, `install:global: bun run build && install -m 755 dist/warden ~/.local/bin/warden`. Each gets `AGENTS.md` + `CLAUDE.md` symlink; update root AGENTS.md layout. Ensure turbo `build` outputs include `dist/**`.
- Tests first: `allocate.test.ts` (free reuse, foreign skip, stale reclaim, pool growth cap, profile/runtime match), `liveness.test.ts`, `store.test.ts` (temp db; two concurrent `claim` processes via `Bun.spawn` never receive the same resource), `owner.test.ts`.
- `WARDEN_HOME` env overrides `~/.warden` (tests, CI).

### WDN-2 detail
- Provider interface `DeviceProvider { platform; inventory(); create(profile, runtime); boot(id); waitReady(id); shutdown(id) }`; iOS impl on `xcrun simctl` with injectable `exec` for tests; fixtures from real `simctl list devices available -j` output.
- `claim` flow: txn(reclaim stale → allocate → insert leases) then outside txn boot/create; if boot fails, release lease.
- `run`: heartbeat timer, signal handlers, exit code passthrough.

### WDN-3 detail
- Android: inventory = `adb devices -l` + `emulator -list-avds`; boot with `-read-only` so one AVD can back several emulators; allocate even console ports 5554–5584 via port leases (depends on WDN-4 store API only, not its CLI).

### WDN-8 detail — later, in delacour-monorepo (`apps/salient/app/scripts/e2e/run-ios.ts`)
- `chooseSimulators` (215): if `warden` resolvable and `E2E_WARDEN !== "0"` → `warden claim ios --profile iphone-17 --count <shards> --label salient-e2e --json`; else current `planSims` path (CI unchanged).
- `startBundler`/`startBackend` (746/734): `warden port claim` instead of `pickPort` when available.
- `cleanup` (677): `warden release` leases (with `--shutdown` unless `E2E_KEEP_SIM=1`). Heartbeat timer during run.
- Replace `scripts/e2e/resolve-dev-build.ts` body with `warden app ensure ios --json` (keep `--hash-only`/`$GITHUB_OUTPUT` shim for CI) and drop the per-device `reinstall-app` when warden reports `installed`.
- Session mode: store lease ids in session.json; `--attach` checks leases still held.
- Tests: extend `parallel-helpers.test.ts` / new `warden-client.test.ts` with fake exec.

### WDN-5 detail — app build cache (generic Expo, any repo)
Goal: a fresh workspace/branch never waits for a native build that already exists somewhere on the machine or on EAS. Port the pure logic of delacour-monorepo `apps/salient/app/scripts/e2e/resolve-dev-build.ts` (`decideBuild` :107, `decidePoll` :125, `parseBuildList` :91, `parseDownloadPath` :96, `storeInCache` :204, EAS zod schema :52) into `packages/core/src/builds/`, generalised.
- **Project config** `warden.config.json` at repo root (or `--project` dir, auto-detect `app.config.*`/`app.json`): `{ projects: [{ name, root, bundleId: { ios, android }, fingerprint?: { command } , eas?: { profile: "development-simulator", workflow?: ".eas/workflows/dev-build.yml", trigger?: boolean }, build?: { ios: "bunx expo run:ios --no-install --no-bundler", android: "…" } }] }`. Zod-validated.
- **Project key** = normalised git remote URL + project subpath (NOT worktree path) → every worktree/branch of the same app shares one cache; different repos never collide.
- **Fingerprint**: project's own `fingerprint.command` if set (salient: `bun run --silent fingerprint:ios`), else `@expo/fingerprint` from the project's node_modules for `--platform ios|android` (respects the project's `fingerprint.config.js`). Hash logged loudly.
- **Resolution order** (stop at first hit):
  1. **Installed**: `installs` table says device already has `bundleId` at this `hash` AND `simctl get_app_container` / `adb shell pm path` confirms → skip install entirely.
  2. **Local cache**: `~/.warden/builds/<projectKey>/<platform>/<hash>/*.app|*.apk` (`builds` table: projectKey, platform, profile, hash, path, source, size, createdAt, lastUsedAt).
  3. **Import on-disk builds**: `warden builds import` + auto-register after any warden-run local build; one-time migration imports `~/.cache/salient-dev-builds/<hash>/` (salient's existing cache) for the salient project key.
  4. **EAS**: `eas build:list --fingerprint-hash <hash> --platform … --profile …` → FINISHED sim build → `eas build:download` → store in cache. In-flight → wait (poll 30 s). Missing → trigger `eas workflow:run` only when `eas.trigger` true, else fall through.
  5. **Local build** last resort: run `build.<platform>` command in the project, locate the produced `.app`/`.apk` (DerivedData / `android/app/build/outputs`), verify its fingerprint equals `hash`, store in cache.
  New fingerprint ⇒ steps 1–3 miss by construction ⇒ always a fresh build (EAS or local) — never a stale binary.
- **Build lock**: a lease of kind `build` keyed `projectKey+platform+hash` so two agents needing the same missing build → one builds/downloads, the other waits then hits cache. Extend `Resource` union: `| { kind: "build"; key: string }`.
- **Install**: `simctl install` / `adb install -r`, then record in `installs` (device, bundleId, hash, installedAt). Reinstall on hash mismatch.
- **Prune**: LRU by `lastUsedAt` down to `--max-size` (default 20 GB); never delete a build currently being installed (build lease held).
- Tests: decision table for the 5-step resolver with fake providers; projectKey normalisation (ssh vs https remotes, worktrees); zod config; prune ordering; build-lock race (two processes, one download).

### WDN-6 detail
- `hooks/claude-pretool.ts`: matcher `mcp__argent__.*|mcp__plugin_goldie_argent__.*`; read `tool_input.udid|device_id`, `session_id` from stdin. Unleased → auto-claim for session, allow. Same session → heartbeat, allow. Other owner → exit 2 with "device <udid> leased by <owner> (<repo>/<worktree>) — run `warden claim ios` and use the returned udid". `list-devices` passes through.
- `SessionEnd` hook → `warden release --session <id>`.
- Global skill `~/.claude/skills/warden/SKILL.md`: when to claim, `warden run` for e2e scripts, never touch unleased booted sims. Update `~/.claude/rules/argent.md` device_selection_rule: "claim via warden before booting/choosing".
- `warden install --claude` writes both (confirm prompt).

## Verification
- `bun run test` (turbo; core + cli) (incl. concurrent-claim race test); `bun run typecheck`; `bun run check`.
- Manual: two terminals `warden run ios --count 1 -- sleep 60` → distinct udids; `warden ls` shows both owners; kill one with SIGKILL → `warden gc` reclaims after ttl.
- (WDN-8) Salient: `bun run --cwd apps/salient/app e2e` in two worktrees at once → disjoint sims + ports.
- Hook: in a Claude session, argent `describe` on a sim leased by another session → blocked with message; on free sim → auto-leased (visible in `warden ls`).
- Builds: fresh worktree of salient with unchanged native code → `warden app ensure ios` returns `source: cache` in seconds; second call on same sim → `installed`; touch a native dep → new hash → EAS or local build; two agents concurrently on a missing hash → one download.
- Android: `warden claim android` twice from same AVD → two emulators, distinct serials.
- Commit per phase; PR `feature/cowrie` → `feature/bun-monorepo-setup` (or main — see Q4).

## Best-practice notes
- sqlite `BEGIN IMMEDIATE` is the cross-process mutex — no hand-rolled lockfiles.
- Never shut down or erase a device warden didn't create or lease (foreign devices are read-only to warden).
- Heartbeat + pid liveness both required: agents' CLI calls are short-lived pids, so agent leases rely on session id + heartbeat (hook refreshes on each tool call).

## Defaults taken (recommended answers unless user overrides)
1. Owner id when no Claude hook stdin (plain agent Bash call): a. `CLAUDE_SESSION_ID`-like env if present else parent pid (rec) · b. require `--owner`
2. Agent lease TTL default: a. 30 min (rec) · b. 10 min · c. 2 h
3. Salient CI: a. keep planSims path, no warden (rec) · b. install warden in CI too
4. PR target for the agent's branch: a. `feature/bun-monorepo-setup` (rec — scaffold lands first) · b. `main`
5. Local-build fallback when EAS has nothing: a. build locally immediately (rec, matches 'last resort') · b. trigger EAS workflow + wait first, local only if `--no-eas-trigger`
