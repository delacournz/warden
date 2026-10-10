# warden

Machine-wide leasing of **iOS simulators, Android emulators, ports and native app builds** for agents, Orca worktrees, repos and humans sharing one Mac. A device or port leased by one owner is never handed to another.

- **Leases** live in one sqlite db (`~/.warden/warden.db`, WAL). Claims run under `BEGIN IMMEDIATE`, which serialises them across processes.
- **Owners**: a Claude session (hook stdin, `CLAUDE_CODE_SESSION_ID`, `WARDEN_SESSION_ID`), CI (`CI`, `GITHUB_RUN_ID`), or a user shell (parent pid). The repo and worktree are recorded for messages.
- **Liveness**: a lease stays alive while its pid is alive or its heartbeat is within the TTL (default 30 min; a bare `warden claim` by an agent gets 5 min and prints a hint, so only wrappers or `warden heartbeat` hold a device longer). Stale leases are reclaimed on every claim and by `warden gc`.
- **Devices**: warden creates and reuses its own `warden-<profile>-N` simulators and launches `-read-only` emulators. It never allocates, shuts down or erases a device it didn't create, unless you pass `--adopt`.
- **Builds**: Expo fingerprint → installed → local cache → EAS → local build. All worktrees of a repo share one cache.

## Install

> The npm release of `@delacour/warden` is pending: the commands below are the intended install path and work once the first version is published. Until then, build from source.

```bash
npm i -g @delacour/warden && warden install    # or: bun add -g @delacour/warden && warden install
```

`warden install` wires hooks for every detected agent (Claude Code / Codex), showing a diff and asking first. Hooks call `~/.local/bin/warden`, which install links to the global package, so `npm i -g @delacour/warden@latest` upgrades both.

One-shot, nothing installed globally:

```bash
npx @delacour/warden install     # or: bunx @delacour/warden install
```

This copies the binary to `~/.local/bin/warden` and wires the hooks. It only puts `warden` on your `PATH` if `~/.local/bin` is already on it (macOS doesn't add it by default). If `warden` isn't found afterwards, use the global install above. To update a one-shot install, run `warden update`, which fetches it from npm, or re-run `npx @delacour/warden@latest install`.

The npm package is a small node shim plus one prebuilt binary per platform (`@delacour/warden-{darwin,linux}-{arm64,x64}`, installed as an optional dependency). Windows isn't supported. Package managers that skip optional dependencies (`--omit=optional`) leave the shim without a binary, and it says so.

From source:

```bash
bun install
bun run --cwd apps/cli install:global   # local build of this checkout → ~/.local/bin/warden
warden install                           # binary + hooks for every detected agent (Claude Code / Codex); shows diff, asks first
warden install --claude                  # force Claude Code only: skill + hooks + argent rule
warden install --codex                   # force Codex only: hooks in $CODEX_HOME/hooks.json
warden doctor
```

Working on warden itself: `bun run cli:link` points `~/.local/bin/warden` at this checkout's source (no rebuilds), and `bun run cli:unlink` puts back whatever was there before.

Agent skill only, for Claude Code, Codex, Cursor and others via the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
warden skill show | pbcopy                 # raw SKILL.md to paste by hand
warden skill install                       # bunx skills add ~/.warden/skill --skill warden -g (this binary's copy)
warden skill install --from github         # bunx skills add delacournz/warden --skill warden -g (updatable via `skills update`)
warden skill install --project -a claude-code -y   # into the current project, one agent, no prompts
```

The skill's source is `skills/warden/SKILL.md`, which is embedded in the binary. `npx` is used when `bunx` isn't available; `--dry-run` prints the command.

For source builds and one-shot installs, `~/.local/bin` must be on `PATH`. Set `WARDEN_HOME` to override `~/.warden`.

## Update

`warden update` does the right thing for however warden was built (`warden version` shows which):

| Build | `warden update` |
|-------|-----------------|
| **dev**: running from source (`bun apps/cli/src/cli.ts update`) | compiles a `local` binary from this checkout → `~/.local/bin/warden` |
| **local**: compiled from a checkout | rebuilds from the checkout it was built from, in place (`--release` switches to releases) |
| **release**: downloaded from GitHub | `gh release view` → newer? download `warden-<os>-<arch>` → verify sha256 → self-check → swap in place. If GitHub releases can't be reached (no `gh`, no repo access), it falls back to npm |
| **release**: copied by `npx`/`bunx @delacour/warden install` | npm registry: `@delacour/warden/latest` → newer? download `@delacour/warden-<os>-<arch>` → verify sha512 `dist.integrity` → self-check → swap in place |
| **npm**: `@delacour/warden` via npm / bun / pnpm / npx / bunx | prints the package manager's upgrade command (e.g. `npm i -g @delacour/warden@latest`, `npx @delacour/warden@latest install`) and leaves `node_modules` alone; `--to <path>` still installs a standalone release binary |

The binary is swapped atomically at the same path, so the next `warden` in your current shell runs the new version. No new shell or `source` is needed; if `PATH` resolves `warden` elsewhere, update warns you. Flags: `--check` (report only), `--force`, `--to <path>`, `--json`. Releases come from the private `delacournz/warden` repo through `gh` (auth required). Set `WARDEN_RELEASE_REPO` to use another repo, and `WARDEN_NPM_REGISTRY` to use another npm registry.

### Releasing

1. Bump `version` in `apps/cli/package.json` and commit.
2. `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` checks that the tag matches the version, runs typecheck/check/test, builds `warden-{darwin,linux}-{arm64,x64}` plus `checksums.txt` (`bun run --cwd apps/cli build:release`) and publishes the GitHub release.
4. The same workflow stages the npm packages (`bun run --cwd apps/cli build:npm` → `apps/cli/dist/npm/`) and publishes `@delacour/warden-<os>-<arch>` then `@delacour/warden` with public access. It needs an `NPM_TOKEN` secret that can publish to the `@delacour` scope. Versions already on npm are skipped, so a re-run finishes a partial publish. While the repo is private, the packages publish with `NPM_TOKEN`, without provenance and without repository / homepage / bugs links (`build:npm --repo-links` or `WARDEN_NPM_REPO_LINKS=1` adds them). Once the repo is public, the workflow adds the links and `--provenance` on its own, and publishing should move to npm trusted publishing (OIDC) so `NPM_TOKEN` can be retired.

## Usage

```bash
warden claim ios --json                          # lease 1 sim (reuse → boot → create), booted + ready
warden claim android --profile pixel-10 --count 2
warden claim ios --count 2 --wait 10m --ttl 1h --label e2e
warden release --mine [--label x] [--shutdown]   # or <leaseId…> | --udid X | --session S; --label = only --mine leases with that label; --shutdown = warden-created or self-booted sims
warden release <leaseId> --bad [reason]          # release + quarantine the device (claims skip it); clear: warden sim unquarantine <udid>
warden sim slim <udid> [--restore]               # slim state is recorded; a plain `warden claim` re-enables what a run left slimmed
warden ls                                        # leases: resource, state, owner, repo/worktree, age, heartbeat
warden clone <udid|name> [--name x]              # duplicate a shut-down sim into the pool (seconds, no first boot)
warden golden ensure|ls|prune [--all]            # golden images new sims are cloned from
warden devices [ios|android]                     # every sim/emulator (booted or not) + AVDs, warden-owned?, leased by (alias: list)
warden sims [--max-size 40G]                     # disk audit: every sim + runtime, size, owner, lease, what can go
warden sims prune [--dry-run|--yes]              # delete idle/orphaned/broken warden sims (+ LRU over --max-size)
warden sims delete [udids...|--suggested] [-y]   # multi-select → confirm → delete sims; stale/dead/duplicate ones pre-ticked (--dry-run)
warden check --udid <udid>                       # exit 2 if another owner holds it
warden heartbeat --mine
warden gc [--idle 20m]                           # reclaim stale leases, shut down idle warden devices

warden port claim --from 8091 --span 20 --json
warden port release --mine
```

### Installing warden in GitHub Actions

The repo is private and the npm package is not required for CI: the release workflow attaches a compiled single-file binary per platform (`warden-darwin-arm64` …, plus `checksums.txt`) to each GitHub release, and a composite action in this repo installs the right one:

```yaml
- uses: delacournz/warden/.github/actions/install-warden@main
  with:
    token: ${{ secrets.WARDEN_RELEASE_TOKEN }}   # optional pin: version: v0.1.0
```

`WARDEN_RELEASE_TOKEN` is a fine-grained PAT (or GitHub App token) with **Contents: read** on `delacournz/warden`; the default `GITHUB_TOKEN` of another repo cannot read it. For `uses:` itself to resolve, allow it under warden's Settings → Actions → General → Access ("accessible from repositories in the delacournz organization"). The action verifies the sha256 and puts `warden` on `PATH`. A bare script works too: `gh release download --repo delacournz/warden --pattern warden-darwin-arm64 --pattern checksums.txt`.

A clean macOS runner needs no prior state: the `--profile` is created on claim (cloned from a golden image that is built on first use, about a minute or two; cache `~/Library/Developer/CoreSimulator/Devices` between runs to keep it) and falls back to `simctl create`. The runner must have the iOS runtime installed.

### Fast new simulators: golden images

A brand-new simulator's first boot (Apple logo + progress bar) takes 1–10 min, and about 80% of that is the one-time data migration. The salient e2e measurements (SAL-GOLDEN):

| Scenario | Time |
|---|---|
| fresh create + first boot | 146–239 s |
| clone of a settled golden + boot | 3.7 s + 11.9 s |
| 3 clones booted in parallel | ~20 s |

So when `warden claim ios` needs a **new** pool device, it `simctl clone`s it from a **golden image**. That is a sim warden booted once, waited on until its data migration had finished (`DMLastMigrationResults`, since `bootstatus -b` can return early) and its CPU had settled, then shut down. The golden is built on first use and keyed by Xcode build + runtime + runtime build + device type + recipe, so an Xcode or runtime upgrade simply builds a new one (`warden golden prune` removes old ones). Clones are APFS copy-on-write (~30 MB each). If cloning fails, warden falls back to `simctl create`. Set `WARDEN_GOLDEN=0` to turn cloning off.

- `warden golden ensure [--profile iphone-17]`: build ahead of time, so the first claim doesn't pay for it.
- A claim that has to build the golden prints `building golden for <profile> … prewarm with: warden golden ensure --profile <profile>` on stderr first.
- `warden clone <udid|name> [--name x]`: duplicate any **shut-down** sim, e.g. one you've set up by hand, into warden's pool. warden refuses a booted source rather than shutting it down.
- Goldens are never allocated, adopted, booted by `gc` or counted in the pool, and `warden devices` labels them `golden`.
- A pool device that already exists is always reused first; a second boot takes ~6.5 s.

### Device health

- After booting (or reusing) an iOS sim, `warden claim` probes it: `simctl spawn <udid> launchctl print system` must answer within 5 s and SpringBoard must be running. A sim that fails is quarantined (and shut down) and another one is claimed, up to 2 retries, then a clear error. Foreign devices that fail are only skipped. Android has no probe yet.
- `warden release <id> --bad [reason]` quarantines the released warden device by hand. `warden devices` shows `quarantined` / `slim`. `warden sim unquarantine <udid|serial>` clears it.
- `warden app ensure` re-installs when the app on the device no longer matches the cached build (iOS: `CFBundleVersion`, executable size and `main.jsbundle` size).

### e2e scripts: `warden run`

```bash
warden run ios --count 2 --port 8091:20 --port 3208:20 [--app] -- bun run e2e
```

`warden run` claims the devices and ports, then runs the command with `WARDEN_UDIDS`, `WARDEN_UDID_<i>`, `WARDEN_LEASE_IDS`, `WARDEN_PORTS` and `WARDEN_PORT_<i>` set. It heartbeats every 30 s, forwards SIGINT/SIGTERM, releases everything on exit and passes the exit code through. With `--app`, it first ensures the dev build is installed on each device (`WARDEN_APP_PATH` / `WARDEN_APP_HASH`).

### Batches: `warden batch`

```bash
ls flows | warden batch ios --count 5 --max 5 --port 8091:20 --serve "bun run metro" --serve-ready tcp:8091 --jobs-from - --retry 1 -- bun run e2e:flow {job} --device {udid}
```

`warden batch` claims N devices and runs a job queue across them, one worker per device: `{job}`, `{udid}`, `{worker}` and `{seq}` are substituted into the command, which also gets `WARDEN_UDID`, `WARDEN_WORKER`, `WARDEN_JOB` and `WARDEN_JOB_SEQ`. `--serve` starts a long-lived process (Metro) first and waits for `--serve-ready`. A live grid tracks every device, and `--record <dir>` (iOS) captures each simulator, the grid and a `batch.json` timeline (`scripts/demo/compose.ts` tiles them into one video). It exits 0 only when every job passed.

Save a batch in `warden.config.ts` and run it by name:

```ts
export default defineConfig({
  batches: {
    "salient-e2e": {
      project: "salient", platform: "ios", count: 5, max: 5, profile: "iphone-17",
      ports: ["8091:20"], app: true, retry: 1,
      env: { E2E_SESSION_FILE: "e2e-artifacts/batch/session.json" },
      serve: "bun scripts/e2e/run-ios.ts --session", serveReady: "file:e2e-artifacts/batch/session.json", serveTimeout: "20m",
      jobsFrom: { command: "bun scripts/e2e/select-flows.ts --list --offline" },
      cmd: ["bun", "scripts/e2e/run-ios.ts", "--attach", "{job}", "--device", "{udid}"]
    }
  }
});
```

```bash
warden batch salient-e2e                        # the preset as-is
warden batch salient-e2e --count 2 -- bun e2e {job}   # passed flags and -- <cmd> override it
```

Flags you pass override the preset (commander defaults don't). `--jobs` / `--jobs-from` replace its jobs source, and `-- <cmd>` replaces `cmd`. With `project`, serve, jobs and `jobsFrom.command` run in that project's root, relative preset paths resolve against it and `app` installs that project's build. Without `project`, the preset's cwd is the config file's directory. CLI paths resolve against your cwd. `env` is added to serve and job env. `label` defaults to the preset name and applies to the port leases too. Fewer jobs than `count` claims one device per job.

### Affected e2e: `warden affected` / `warden e2e`

```bash
warden affected mobile --base origin/main --explain   # which flows this branch needs, and why
warden e2e mobile --base origin/main --count 2        # run them on leased devices; exit 1 if a required one fails
```

An `e2e.<suite>` in `warden.config.ts` maps flow files to the screens they drive (`entries`) and globs (`paths`). Warden takes the git diff against the merge-base, walks each flow's import graph with the TypeScript resolver (tsconfig `paths`, workspace packages, per-platform `.ios` / `.android` files, type-only imports dropped), and runs only the flows a changed file reaches, with `runAll` globs (lockfile, native dirs) selecting everything. `warden e2e` runs them like `warden batch`, each `passes` times, and writes `e2e-report.json`. See the [Affected e2e guide](apps/docs/content/docs/guides/affected-e2e.mdx).

### App builds

```bash
warden app fingerprint ios
warden app ensure ios --udid <udid> --json   # { appPath, hash, source: installed|cache|eas|build, installed }
warden builds ls | prune --max-size 20G | import <App.app> --hash <h>
```

Optional `warden.config.ts` at the repo root (`bun add -d @delacour/warden` for autocompletion; `warden.config.json` still works):

```ts
import { defineConfig } from "@delacour/warden/config";

export default defineConfig({
  projects: [{
    name: "salient",
    root: "apps/salient/app",
    bundleId: { ios: "com.example.salient", android: "com.example.salient" },
    fingerprint: { command: "bun run --silent fingerprint:{platform}" },
    eas: { profile: "development-simulator", workflow: ".eas/workflows/dev-build.yml", trigger: false },
    build: { ios: "bunx expo run:ios --no-install --no-bundler" }
  }]
});
```

With no config, warden detects a single project from `app.json` / `app.config.*` (pass `--bundle-id` for a dynamic config). It resolves builds in this order: already installed at this hash → `~/.warden/builds/<projectKey>/<platform>/<hash>` → legacy caches → EAS (`build:list --fingerprint-hash`, then download; waits for builds in flight; triggers the workflow only if `trigger` is set) → local build, which is verified against the fingerprint. A build lock stops two agents from downloading or building the same hash twice.

`warden install` wires hooks into every agent it detects: Claude Code (`~/.claude` or `claude` on PATH) and Codex (`$CODEX_HOME` / `~/.codex` or `codex` on PATH). `--claude` / `--codex` force one (or both) regardless of detection. Every agent config change shows a diff and asks first (`--yes` skips, `--dry-run` only prints, a non-TTY without `--yes` skips). Merges are idempotent and keep all other config.

### agent-device

Claim, then pass the device explicitly: `warden claim ios --json` → `agent-device … --platform ios --udid <udid>` (Android: `--serial`). A bare agent claim lasts about 5 min and nothing refreshes it; only `warden dev` / `run` / `batch` / `e2e` or an explicit `warden heartbeat <leaseId>` hold a device longer. For exploration, run `warden dev ios --json` in the background (claims and holds a device + a Metro port, starts a Metro verified to serve this checkout, opens the dev client) and target the `udid` from its first stdout line. Subagents never call `release --mine`: use `release <leaseId>`, or claim with `--label x` and `release --mine --label x`.

### Claude Code

`warden install --claude` adds:

- a **PreToolUse** hook on `mcp__argent__.*|mcp__plugin_goldie_argent__.*`. An unleased device is auto-claimed for the session (argent is retired: do not rely on this to hold a lease), and a device leased by another owner is blocked (exit 2) with the owner and repo/worktree.
- a **SessionEnd** hook, which **shuts down the session's sims** and releases its leases, so nothing is left running. Only sims warden created, or that the session booted itself (they were off when it first touched them), are shut down. A sim that was already running when the agent picked it up, such as your own Simulator.app one, is released but left on. On `/clear` (reason `clear`) sims keep running: the conversation restarts, the work usually continues, and the new session re-claims the sim on its next argent call.
- **Sessions that die without SessionEnd** (killed or terminal closed): their leases go stale after their TTL (30 min; 5 min for a bare agent claim). `warden gc` then shuts those sims down under the same rule, but only 10+ min after the lease went stale and never while a non-Apple app is running on the sim. gc runs automatically in the background at most every 10 min, triggered by hook activity and by `claim`/`run` (`WARDEN_AUTO_GC=0` turns this off), as well as on demand.
- the `~/.claude/skills/warden/SKILL.md` skill, plus a "claim via warden first" line in the argent `device_selection_rule`.

### Codex

`warden install --codex` merges the same two hooks into `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`; hooks already declared in `config.toml` `[[hooks.*]]` tables count as installed). Codex hooks use Claude's format and stdin JSON, and a PreToolUse exit 2 + stderr blocks the call, so `warden hook pretool|session-end` serves both agents unchanged:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "mcp__argent__.*|mcp__plugin_goldie_argent__.*",
                     "hooks": [{ "type": "command", "command": "$HOME/.local/bin/warden hook pretool", "timeout": 30 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "$HOME/.local/bin/warden hook session-end", "timeout": 3 }] }]
  }
}
```

- Codex **skips new or changed hooks until you trust them**: run `/hooks` in Codex once after installing.
- Codex caps SessionEnd hooks at 3 s and always sends reason `other`, so the `/clear` keep-sims-running exception never applies there. Anything the SessionEnd hook can't finish in time is picked up by `warden gc` once the leases go stale.
- For the skill in Codex, use `warden skill install`.

## Development

```bash
bun run test        # turbo: core + cli (incl. cross-process race tests)
bun run typecheck
bun run check       # biome
```

See [AGENTS.md](AGENTS.md) and the plan in [docs/plans/wdn-warden-cli.md](docs/plans/wdn-warden-cli.md).

## License

[MIT](LICENSE)
