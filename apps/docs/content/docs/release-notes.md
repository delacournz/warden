---
title: Release notes
description: What changed in each warden release, from the changesets that shipped it.
icon: ScrollText
---

Every version of `@delacour/warden` (and `@delacour/warden-e2e`, which moves in lock-step). Run `warden update` to get the latest, see [Updating & releasing](/docs/updating).

## Unreleased

Merged into `develop`, shipping in the next release.

### Minor changes

- `warden builds rm <hash…>` (alias `remove`) removes cached builds by hash or a unique prefix (at least 6 characters), with their aliases, and forgets the install records at those hashes so the next `warden dev` / `warden app ensure` reinstalls on those devices. `--platform`, `--dry-run`, `--yes` and `--json` (`{ dryRun, removed, forgotInstalls }`) are supported. It asks first in a terminal, and refuses a prefix that matches several builds or a build being fetched or built right now.
- `warden dev`: declining the `warden.config.ts` offer for an app read through `expo config` now writes the config to the repo's overlay under `~/.warden/projects/<repo>/` instead of skipping it, so later starts (from any worktree or branch of the same repo) skip the `expo config` call without a file in the checkout. A monorepo app gets `root` set to its path from the checkout. A `warden.config.ts` in the repo always wins over the overlay one.
- `warden dev` draws a dashboard on an interactive terminal: task rows on the left (claim device, show simulator, dev build, metro, dev client, session), the selected row's live output on the right, and Metro's own terminal in the metro row. `--no-tui` or `WARDEN_TUI=0` keeps the plain output; `--json`, pipes and CI are always plain.
- The dashboard has two modes. List mode takes warden's keys; `Enter` or `i` on the metro row sends every key to Expo (`a`, `i`, `w`, `j`, `r`, `m`, `o`, `?`) until `Esc`, `Esc Esc` sends a literal Esc, and `Shift+PgUp` / `Shift+PgDn` scroll Metro's history. `?` lists the keys.
- Action keys in list mode: `r` reload, `d` show the simulator, `o` open the dev client, `s` screenshot, `R` reinstall the dev build, `x` restart the simulator (iOS), `c` restart Metro with `--clear`, `l` stream device logs, `h` toggle the HUD, `q` quit and release.
- The perf keys drive `warden perf` sessions from the dashboard: `p` starts and stops a session, `P` records every capture, `m` asks for a mark label, `f` reads frames (Android) and `g` shows the report. One session records per device, and `R` and `x` are refused while it does.
- A perf HUD at the top right (terminals 100 columns or wider) shows CPU with a short history, memory (RSS on iOS, PSS on Android), fps and jank (Android), Metro's last bundle time and the recording clock. `--no-hud` turns it off and `--hud-interval <duration>` sets the sampling interval (default `1s`, minimum `200ms`).
- Each dashboard session writes `warden.log`, `metro.log` and `shots/` under `$WARDEN_HOME/dev/<leaseId>/`; `warden gc` removes a session directory once its lease is gone and its files are 24 hours old.
- `perf metrics --watch` on iOS costs ~1% of a core instead of ~16%: the app's pid is resolved once and each sample is one pid-scoped `ps`.
- `warden dev` holds one devtools connection to the app for the whole session (the dashboard's `devtools` row). It captures console lines, uncaught exceptions and `fetch` calls from launch, and `warden ui` devtools verbs read from it instead of opening their own connection. Without a dev session they connect directly as before.
- `warden dev logs` reads Metro's output, classified as `bundle_start`, `bundle_done`, `bundle_failed`, `hmr`, `error`, `warn` and `info`, with file, line and code frame for bundle and transform errors. It takes `--since`, `--tail`, `--grep`, `--kind`, `--follow` and `--json`.
- New `warden ui exceptions`, `warden ui route` and `warden ui devtools status|resume`. `warden ui logs` and `warden ui network` gain `--since`, `--level`, `--grep`, `--status` and `--limit`.
- Exception and console stacks are symbolicated through Metro to source file and line, with Metro's code frame. Errors React Native reports through its exception handler count as exceptions.
- `warden ui logpoint add <file:line[:col]> '<expression>'` logs a value every time a source line runs, without pausing the app or editing code. `--hits <n>` removes it after n hits. It comes with `logpoint list|rm|clear|hits`. Logpoints are set again after a reload and end with the session. They need the Fusebox debugger.
- `warden perf js` records through the dev session's connection when `warden dev` runs. Other perf captures hand the connection back when they finish.
- `warden perf js` hotspots now map to source on React Native apps, which load their bundle as `index.bundle//&…`.
- When Chrome DevTools takes the app on a Metro that allows one debugger, the session's connection waits instead of taking it back. `warden ui devtools resume` reattaches.
- `warden mcp` is an MCP server on stdio. Its tools are `dev_sessions`, `metro_logs`, `app_console`, `app_exceptions`, `app_network`, `app_eval`, `app_tree`, `app_route`, `app_reload`, `logpoint_add|hits|list|remove`, `profile_start|stop|status` and `devtools_status|resume`.
- `warden dev` (and every command that finds the project) works from a monorepo root without a `warden.config.ts`: when nothing is found upwards it looks below, in the package.json `workspaces` (else `apps/*` and `packages/*`). One app there is used and named; with several, `warden dev` asks which one, and a pipe gets the list and `--project <dir>`.
- `warden dev` runs bare React Native apps. An app whose package.json depends on `react-native` but not `expo` gets its bundle ids from `ios/*.xcodeproj` and `android/app/build.gradle`, Metro as `react-native start` on the leased port, `react-native build-ios` / `build-android` as the default local build, and is relaunched against Metro (`-RCT_jsLocation` on iOS, port 8081 reversed on Android). No `expo-dev-client` is asked for. `c` restarts Metro with `--reset-cache`.
- New `projects[].framework` (`"expo"` | `"react-native"`) in `warden.config.ts` overrides the guess from package.json.
- `warden dev` resolves an app whose config is code (`app.config.ts` / `.js` / `.mjs` / `.cjs`) without a bundle id in `app.json`: it runs `expo config --json --type public` in the app directory once and takes the bundle id, slug and scheme from the result, instead of stopping with "app.config.ts is dynamic". `--bundle-id` still overrides it and a `warden.config.ts` skips the call. The same applies to every command that finds the project this way (`warden app`, `warden e2e`, `warden run`).
- `warden dev` checks the request and the app before it leases a device or opens the dashboard, and a failure there is one line with the fix on the terminal. With a person at the terminal each missing piece is offered: a package the dev-client run needs (`expo-dev-client`) is added and installed through the checkout's package manager (`yarn` / `pnpm` / `bunx` / `npx` `expo install`, from the nearest lockfile), and an app read through `expo config` can get a `warden.config.ts` with the resolved ids so later starts skip the call (run through the checkout's prettier when it has one). Without a terminal (`--json`, a pipe) the blocking issues are the error, each with its command.
- The dashboard no longer swallows a failure: when the session never comes up, or Metro dies, warden's lines are printed to the terminal after the dashboard has closed, with the session log directory.
- `warden init` names the install command for the checkout's package manager instead of always `bunx expo install`.
- `warden claim` (and `run`, `dev`, `batch`) refuses to boot or create a device when free space is under the critical threshold, failing with `DISK_LOW` and the free space it saw; reusing an already booted device is always allowed. Swap above its warn threshold queues the claim the way memory pressure does.
- A background `warden gc` starts at once when free space drops under the disk floor, without waiting for the usual 10-minute interval (at most once a minute).
- `WARDEN_GC_WORKTREES=merged` lets `warden gc` remove clean, merged git worktrees, as `warden worktrees --apply` does; off by default. `warden disk` lists worktrees with what is removable.
- `warden hook session-start` prints one line for the agent when the disk is low or swap is high (reuse booted devices, avoid parallel builds), and nothing otherwise; `warden install` adds it to Claude Code and Codex hooks and `warden doctor` checks it.
- `WARDEN_DISK=off` turns off the claim gate, the low-disk gc trigger and the session-start hint.
- `warden disk [--json]` reports what is filling the disk on an agent machine, read-only: free space, swap, memory pressure, booted devices, APFS local snapshots (a staged macOS update vs Time Machine) and uptime, each warning with a one-line fix. Swap and snapshot warnings come first, since deleting files won't stop swap refilling the disk.
- It also lists what warden can give back: the build cache against its cap, deletable simulators, and orphaned Xcode DerivedData / XCTest device clones.
- Thresholds: free space under max(20 GB, 10%) warns, under max(8 GB, 4%) is critical, swap over 8 GB warns. Override with `WARDEN_DISK_FLOOR_GB`, `WARDEN_DISK_CRITICAL_GB` and `WARDEN_DISK_SWAP_WARN_GB`.
- `warden doctor` adds `disk-free`, `swap` and `snapshots` checks.
- `warden e2e` and `warden ui record stop` no longer need bun installed: warden runs the specs with the bun built into its own binary. `WARDEN_BUN` still picks a different bun.
- On iOS, `fill` pastes the text with one Cmd+V instead of typing every character, about 400 ms whatever its length. Secure fields are pasted too.
- `locator.fill(text, { via: "paste" | "type" })` and `warden ui fill --via paste|type` choose how the text goes in; `paste` is the default and `type` keeps the old key-by-key typing. Android always types.
- A paste that cannot be confirmed on the simulator pasteboard is typed in the same attempt, and the retry after a failed read-back always types, so a field that mangles a paste (a mask, a `maxLength`) still passes.
- `warden ui record` writes `via: "type"` on a fill step that was typed, and the generated spec passes `{ via: "type" }`; existing recordings are unchanged.
- `warden gc` sweeps Xcode DerivedData whose recorded workspace no longer exists (the build output of deleted worktrees), and the `XCTestDevices` clone set when no `xcodebuild` is running and nothing in it has changed for an hour. A workspace on an unmounted volume, a DerivedData dir that records none, or one an `xcodebuild` is using is kept; when running processes can't be inspected, nothing is removed.
- `warden gc --dry-run` lists those orphans with their sizes and changes nothing; `warden gc --no-orphans` skips the sweep.
- Every iOS simulator warden creates boots already slim by default. `--slim` / `--no-slim` on `claim`, `run`, `dev`, `batch` and `e2e`, config `slim` (top-level, `e2e.<suite>.slim`, `batches.<name>.slim`) as `true | false | { except, keep }`, and `WARDEN_SLIM=0` choose per run, per suite or per machine.
- The slim overrides are written to the simulator before its first boot, so clones come up slim with no per-daemon spawns. Once the sim is ready they are read back, and any drift is fixed live.
- `warden sim slim --except <categories>` and `--keep <labels>` leave whole categories or single `com.apple.*` labels running. `warden sim profiles` lists the categories.
- `warden sim measure [udid|--booted]` prints a booted simulator's real memory (summed `phys_footprint`) and its heaviest processes. `warden devices --mem` adds the figure to the device list.
- `warden capacity` counts a slim simulator at 1792 MB and a stock one at 4096 MB (measured, up from 2048), so admission matches what simulators really use. `cost.ios.memMb` and `cost.ios.slimMemMb` override them.
- `gamed` and `nanotimekitcompaniond` are no longer disabled, and are re-enabled on a simulator an older warden already slimmed.
- A plain `warden claim` no longer restores a slimmed simulator. `warden sim slim --restore` does.
- `warden worktrees [--root <dir>…] [--idle 3d] [--no-fetch] [--no-size] [--json]` audits the linked git worktrees of every repo warden has leased for (plus the current one and any `--root`), with size and evidence: `merged`, `review` (uncommitted changes or commits on no remote), `unmerged`, `active` (changed within `--idle`), `in-use` (a process or live lease inside it), `locked` and `stale-ref`.
- `warden worktrees --apply` removes only clean `merged` worktrees with `git worktree remove` and prunes `stale-ref` entries. A merged PR counts only when its head is the worktree's HEAD. Branches are never deleted, and it refuses to remove the worktree you are standing in.

### Patch changes

- `warden claim`, `warden run` and `warden dev` say what a claim is doing while it creates or boots a device (`creating …`, `… booting`, `… waiting until it is ready`), so `warden dev`'s claim row is no longer blank during a slow boot. A warm booted device is still claimed silently.
- `warden dev`'s dashboard streams the local build's own output (`expo run:ios`, xcodebuild, Gradle) into the dev build row while it runs, instead of showing nothing until the build ends. The `R` reinstall action streams it into its row too. Plain output (`--no-tui`, `--json`, pipes, agents) is unchanged.
- `warden dev`, `warden app ensure` and `warden run --app` no longer cache a dev build made from a stale git-ignored `ios/` / `android/` dir. When the native fingerprint has changed since that dir was prebuilt (a new native dependency such as `expo-application`), or warden does not know which fingerprint it was prebuilt for, the local build removes it first so `expo prebuild` and `pod install` run again. Before, the build skipped both and linked none of the new native modules, so the dev client crashed with `Cannot find native module '<X>'`. A committed native dir, and a custom `build` command that does not run `expo prebuild` / `expo run:*`, are left as they are.
- `warden claim` / `warden dev` no longer queue forever on macOS when the kernel reports memory pressure `warn` while plenty of memory is free: a kernel `warn` now holds the boot queue only when `memory_pressure` also shows under 25% free (`critical` still always holds). `warden capacity` shows the same reading.
- `warden dev`'s dashboard shows the claim's progress under the claim row (`queued #1 of 1 (high) — memory pressure warn` and similar), instead of sitting on "preparing the ios dev build" with no output.
- `warden dev` boots a held simulator that is shut down (`--udid`, `--lease`, or the device lease an earlier session in the same shell left behind) and waits for it before installing, instead of opening Device Hub on a stopped sim and failing with "Unable to lookup in current state: Shutdown". It only boots a device under the session's own lease; a shut-down device that is not yours is an error naming it.
- `warden dev` on iOS opens the Expo dev client without the dev menu's first-run onboarding sheet or the dev menu covering the app at launch. The dev menu stays reachable by shake, ⌃D or the floating button.
- The warden skill says `warden dev ios` opens without the sheet, and that `warden ui open --relaunch` can still show it.
- `warden dev` shows the simulator it leased: once the device is held it brings the sim's window to the front, launching Device Hub (Xcode 27) or Simulator.app (Xcode ≤ 26) when no viewer is running, instead of leaving the window behind other apps or never opening one. `--headless` skips it; a viewer that can't be opened is a warning, not a failure.
- `warden dev` shuts the simulator it booted down when it ends (Metro exits, Ctrl-C, a kill), and closes its Device Hub / Simulator.app window, instead of leaving it running until `warden gc` with a window behind. A sim that was already booted when leased, or one given with `--udid` / `--lease`, is left on. `--no-shutdown` keeps dev's own sim booted.
- `warden dev` and `warden run` treat the terminal going away (SIGHUP) like Ctrl-C: the child is stopped and the leases released.
- A `settle` no longer counts as input for the stable-frame rule: an action right after `app.open()` or a `device.settle()` that reported quiet trusts its one look instead of taking a second snapshot.
- On iOS, an action whose look followed a tap or a key within 300 ms confirms that its element has stopped moving with one hit-test instead of a second whole-screen snapshot (not with `systemAlerts` set, where the full look is what finds an alert).
- iOS typing is about 2.6x faster: the default key pacing drops to 5 ms after a key, 20 ms hold and 50 ms before a repeated key, down from 30, 40 and 300 (about 38 ms per character instead of 99 on a local simulator).
- `WARDEN_SIMD_PACE_MS`, `WARDEN_SIMD_HOLD_MS` and `WARDEN_SIMD_REPEAT_GAP_MS` and the `paceMs`, `holdMs` and `repeatGapMs` request fields still override the defaults.
- The typing delays no longer go through the simulator library's timers, so a loaded host (a CI VM) stops stretching them into several times the requested pause.
- iOS `app.launch`, `app.terminate` and `app.openUrl` (every spec `app.open`, `device.openLink` and `warden ui open`) run inside the resident `warden-simd` helper instead of spawning `xcrun simctl` for each call: the helper already holds CoreSimulator, which every `simctl` process loaded again (about 0.13 CPU-s on the host per launch, roughly 40 % of warden's host CPU per bench rep). Launch arguments and environment reach the app as before, `relaunch: false` keeps a running instance, terminating an app that is not running is still a success, and the `driver.app.launch` span now carries `via` (`simd` or `simctl`) and the app's `pid`.
- A helper built before these ops answers once and the driver falls back to `simctl` for the rest of the session (`[ios] this warden-simd predates the \`launch\` op …` in the log; restart it with `warden ui close --udid <udid>` or rebuild with `bun run --cwd packages/e2e native:build`). Install, uninstall, `isRunning` and `clearData` stay on `simctl`.
- The warden agent skill (`warden skill install`, `warden install`) matches the current CLI: `warden builds`, `warden dev logs`, `warden mcp` tools, `warden perf` subcommands, `warden ui` devtools verbs and the flags added since 0.3 are documented, and stale defaults and error codes are corrected.

## 0.3.1

[GitHub release](https://github.com/delacournz/warden/releases/tag/v0.3.1)

### Patch changes

- [#74](https://github.com/delacournz/warden/pull/74) `bun run release <version>` asks npm about every package before writing the version or building: a version already published for all of them is reported and skipped without touching the tree, and packages that already have it are listed as skipped up front.

## 0.3.0

[GitHub release](https://github.com/delacournz/warden/releases/tag/v0.3.0)

### Minor changes

- [#72](https://github.com/delacournz/warden/pull/72)
  - `warden ui record start|note|undo|use|status|cancel|stop` ([#63](https://github.com/delacournz/warden/issues/63)): every `warden ui` action and query is journalled under `$WARDEN_HOME/ui/<udid>/`, and `stop` writes a typed `@delacour/warden-e2e` spec (or an exported helper) directly, then runs it once on the leased device (`--no-verify` skips). The journal is kept until a passing `stop` or a `cancel`, so you can `undo`, fix and `stop` again.
  - `record use` runs an exported helper on the device, then records an import and a call to it.
  - Generated specs use durable selectors only (testID > role+label > text); `snapshot -i` marks elements without one as `[no-id]`. Lints: `coords_target`, `text_only_selector`, `ambiguous_selector`, `unverified_navigation`, `empty_recording`.
  - Secrets typed through `WARDEN_UI_SECRET_<NAME>` never land in the spec; testIDs are merged into an ids module; `wait` / `is` / `get` become auto-waiting expects; `app.open({ wait: "quiet" })`.
  - Recordings reuse the suite's shared `test.use` options and emit `launch: "none"` when the recording or its helper opens the app itself.
  - `stop` prints the `specs.<id>` entries for `warden.config.ts` from the routes seen on a dev client (helper routes merged); it never edits the config.

## 0.2.0

[GitHub release](https://github.com/delacournz/warden/releases/tag/v0.2.0)

### Minor changes

- [#58](https://github.com/delacournz/warden/pull/58)
  - `warden-simd` links idb v1.7.7, whose typed bridge answers replace the generic frame decode: the helper's CPU per accessibility read drops by about three quarters (host 9.12 → 3.79 CPU-seconds per bench rep on EAS `macos-large` with the equivalent patch), memory unchanged. A guest that stops answering now surfaces as `E_TIMEOUT` with the seconds allowed.
  - `WARDEN_SIMD_TIMEOUT` (a duration, e.g. `60s`) sets the per-request timeout of the helper client `warden ui` and the e2e runner connect with; the default stays 10 s.
  - `warden e2e` / `warden dev` honour the core `eas: false` opt-out and never call eas-cli when it is set.
  - Golden settle probe works without a GUI launchd session (hosted workers, ssh).

### Patch changes

- [#69](https://github.com/delacournz/warden/pull/69) iOS `typeText` with characters the HID keyboard cannot type (`café`, emoji, CJK) pastes the right text again on Xcode 27.1: the simulator pasteboard is written through `devicectl device pasteboard copy` (falling back to `simctl pbcopy`) and confirmed with `pbpaste` before the paste keystroke. `simctl pbcopy` exits 0 there without changing the pasteboard, so the field used to receive whatever the Mac had copied last. An unconfirmed write is now `E_IO` and nothing is pasted.

## 0.1.2

[GitHub release](https://github.com/delacournz/warden/releases/tag/v0.1.2)

### Patch changes

- [#64](https://github.com/delacournz/warden/pull/64) Releases now flow through a changesets "Version Packages" PR into `develop`; merging it fast-forwards `main`, which deploys the docs and publishes the npm packages together.
