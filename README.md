# warden

Machine-wide leasing of **iOS simulators, Android emulators, ports and native app builds** for agents, Orca worktrees, repos and humans sharing one Mac. A device or port leased by one owner is never handed to another.

- **Leases** live in one sqlite db (`~/.warden/warden.db`, WAL). Claims run under `BEGIN IMMEDIATE`, which serialises them across processes.
- **Owners**: a Claude session (hook stdin, `CLAUDE_CODE_SESSION_ID`, `WARDEN_SESSION_ID`), CI (`CI`, `GITHUB_RUN_ID`), or a user shell (parent pid). The repo and worktree are recorded for messages.
- **Liveness**: a lease stays alive while its pid is alive or its heartbeat is within the TTL (default 30 min). Stale leases are reclaimed on every claim and by `warden gc`.
- **Devices**: warden creates and reuses its own `warden-<profile>-N` simulators and launches `-read-only` emulators. It never allocates, shuts down or erases a device it didn't create, unless you pass `--adopt`.
- **Builds**: Expo fingerprint → installed → local cache → EAS → local build. All worktrees of a repo share one cache.

## Install

```bash
bun install
bun run --cwd apps/cli install:global   # local build of this checkout → ~/.local/bin/warden
warden install --claude                  # skill + Claude hooks + argent rule (shows diff, asks first)
warden doctor
```

Agent skill only, for Claude Code, Codex, Cursor and others via the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
warden skill show | pbcopy                 # raw SKILL.md to paste by hand
warden skill install                       # bunx skills add ~/.warden/skill --skill warden -g (this binary's copy)
warden skill install --from github         # bunx skills add delacournz/warden --skill warden -g (updatable via `skills update`)
warden skill install --project -a claude-code -y   # into the current project, one agent, no prompts
```

The skill's source is `skills/warden/SKILL.md`, which is embedded in the binary. `npx` is used when `bunx` isn't available; `--dry-run` prints the command.

`~/.local/bin` must be on `PATH`. Set `WARDEN_HOME` to override `~/.warden`.

## Update

`warden update` does the right thing for however warden was built (`warden version` shows which):

| Build | `warden update` |
|-------|-----------------|
| **dev**: running from source (`bun apps/cli/src/cli.ts update`) | compiles a `local` binary from this checkout → `~/.local/bin/warden` |
| **local**: compiled from a checkout | rebuilds from the checkout it was built from, in place (`--release` switches to releases) |
| **release**: downloaded from GitHub | `gh release view` → newer? download `warden-<os>-<arch>` → verify sha256 → self-check → swap in place |

The binary is swapped atomically at the same path, so the next `warden` in your current shell runs the new version. No new shell or `source` is needed; if `PATH` resolves `warden` elsewhere, update warns you. Flags: `--check` (report only), `--force`, `--to <path>`, `--json`. Releases come from the private `delacournz/warden` repo through `gh` (auth required). Set `WARDEN_RELEASE_REPO` to use another repo.

### Releasing

1. Bump `version` in `apps/cli/package.json` and commit.
2. `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` checks that the tag matches the version, runs typecheck/check/test, builds `warden-{darwin,linux}-{arm64,x64}` plus `checksums.txt` (`bun run --cwd apps/cli build:release`) and publishes the GitHub release.

## Usage

```bash
warden claim ios --json                          # lease 1 sim (reuse → boot → create), booted + ready
warden claim android --profile pixel-10 --count 2
warden claim ios --count 2 --wait 10m --ttl 1h --label e2e
warden release --mine [--shutdown]               # or <leaseId…> | --udid X | --session S
warden ls                                        # leases: resource, state, owner, repo/worktree, age, heartbeat
warden clone <udid|name> [--name x]              # duplicate a shut-down sim into the pool (seconds, no first boot)
warden golden ensure|ls|prune [--all]            # golden images new sims are cloned from
warden devices [ios|android]                     # every sim/emulator (booted or not) + AVDs, warden-owned?, leased by (alias: list)
warden check --udid <udid>                       # exit 2 if another owner holds it
warden heartbeat --mine
warden gc [--idle 20m]                           # reclaim stale leases, shut down idle warden devices

warden port claim --from 8091 --span 20 --json
warden port release --mine
```

### Fast new simulators: golden images

A brand-new simulator's first boot (Apple logo + progress bar) takes 1–10 min, and about 80% of that is the one-time data migration. The salient e2e measurements (SAL-GOLDEN):

| Scenario | Time |
|---|---|
| fresh create + first boot | 146–239 s |
| clone of a settled golden + boot | 3.7 s + 11.9 s |
| 3 clones booted in parallel | ~20 s |

So when `warden claim ios` needs a **new** pool device, it `simctl clone`s it from a **golden image**. That is a sim warden booted once, waited on until its data migration had finished (`DMLastMigrationResults`, since `bootstatus -b` can return early) and its CPU had settled, then shut down. The golden is built on first use and keyed by Xcode build + runtime + runtime build + device type + recipe, so an Xcode or runtime upgrade simply builds a new one (`warden golden prune` removes old ones). Clones are APFS copy-on-write (~30 MB each). If cloning fails, warden falls back to `simctl create`. Set `WARDEN_GOLDEN=0` to turn cloning off.

- `warden golden ensure [--profile iphone-17]`: build ahead of time, so the first claim doesn't pay for it.
- `warden clone <udid|name> [--name x]`: duplicate any **shut-down** sim, e.g. one you've set up by hand, into warden's pool. warden refuses a booted source rather than shutting it down.
- Goldens are never allocated, adopted, booted by `gc` or counted in the pool, and `warden devices` labels them `golden`.
- A pool device that already exists is always reused first; a second boot takes ~6.5 s.

### e2e scripts: `warden run`

```bash
warden run ios --count 2 --port 8091:20 --port 3208:20 [--app] -- bun run e2e
```

`warden run` claims the devices and ports, then runs the command with `WARDEN_UDIDS`, `WARDEN_UDID_<i>`, `WARDEN_LEASE_IDS`, `WARDEN_PORTS` and `WARDEN_PORT_<i>` set. It heartbeats every 30 s, forwards SIGINT/SIGTERM, releases everything on exit and passes the exit code through. With `--app`, it first ensures the dev build is installed on each device (`WARDEN_APP_PATH` / `WARDEN_APP_HASH`).

### App builds

```bash
warden app fingerprint ios
warden app ensure ios --udid <udid> --json   # { appPath, hash, source: installed|cache|eas|build, installed }
warden builds ls | prune --max-size 20G | import <App.app> --hash <h>
```

Optional `warden.config.json` at the repo root:

```json
{
  "projects": [{
    "name": "salient",
    "root": "apps/salient/app",
    "bundleId": { "ios": "com.example.salient", "android": "com.example.salient" },
    "fingerprint": { "command": "bun run --silent fingerprint:{platform}" },
    "eas": { "profile": "development-simulator", "workflow": ".eas/workflows/dev-build.yml", "trigger": false },
    "build": { "ios": "bunx expo run:ios --no-install --no-bundler" }
  }]
}
```

With no config, warden detects a single project from `app.json` / `app.config.*` (pass `--bundle-id` for a dynamic config). It resolves builds in this order: already installed at this hash → `~/.warden/builds/<projectKey>/<platform>/<hash>` → legacy caches → EAS (`build:list --fingerprint-hash`, then download; waits for builds in flight; triggers the workflow only if `trigger` is set) → local build, which is verified against the fingerprint. A build lock stops two agents from downloading or building the same hash twice.

### Claude Code

`warden install --claude` adds:

- a **PreToolUse** hook on `mcp__argent__.*|mcp__plugin_goldie_argent__.*`. An unleased device is auto-claimed for the session, the session's own device gets a heartbeat, and a device leased by another owner is blocked (exit 2) with the owner and repo/worktree.
- a **SessionEnd** hook, which releases the session's leases. (`warden claim` run from the agent's Bash tool is owned by the same session via `CLAUDE_CODE_SESSION_ID`.)
- the `~/.claude/skills/warden/SKILL.md` skill, plus a "claim via warden first" line in the argent `device_selection_rule`.

## Development

```bash
bun run test        # turbo: core + cli (incl. cross-process race tests)
bun run typecheck
bun run check       # biome
```

See [AGENTS.md](AGENTS.md) and the plan in [docs/plans/wdn-warden-cli.md](docs/plans/wdn-warden-cli.md).
