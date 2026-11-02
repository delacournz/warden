import type { CommandEntry } from "../command";

/**
 * Every command, listed without importing it: `name`/`group`/`summary` drive root `--help`, `load` imports the
 * command's module only when `warden <name>` runs (or help needs them all). Keep each listing equal to the
 * `defineCommand` in its module; `registry.test.ts` fails when they drift.
 */
export const COMMANDS: readonly CommandEntry[] = [
	{
		name: "claim",
		group: "Lease",
		summary: "lease iOS sims / Android emulators (reuse, boot or create), booted and ready",
		load: async () => (await import("./claim")).claimCommand,
	},
	{
		name: "release",
		group: "Lease",
		summary: "release leases (optionally shut down devices warden created)",
		load: async () => (await import("./release")).releaseCommand,
	},
	{
		name: "run",
		group: "Run",
		summary: "claim devices, run a command with WARDEN_UDIDS set, release on exit",
		load: async () => (await import("./run")).runCommand,
	},
	{
		name: "dev",
		group: "Run",
		summary:
			"install the cached dev build for this fingerprint, start Metro, open the dev client (replaces expo run:*)",
		load: async () => (await import("./dev")).devCommand,
	},
	{
		name: "batch",
		group: "Run",
		summary: "claim N devices, fan a job queue out over them (one worker per device), release at the end",
		load: async () => (await import("./batch")).batchCommand,
	},
	{
		name: "affected",
		group: "Run",
		summary: "list the e2e specs a change needs (git diff vs base → import graph → specs)",
		load: async () => (await import("./affected")).affectedCommand,
	},
	{
		name: "e2e",
		group: "Run",
		summary: "run the e2e specs a change needs on leased devices; exit 1 if a required spec fails",
		load: async () => (await import("./e2e")).e2eCommand,
	},
	{
		name: "perf",
		group: "Run",
		summary:
			"profile an app on a warden device: sessions, marks, doctor (CPU, memory, frames, startup, JS, React, native)",
		load: async () => (await import("./perf")).perfCommand,
	},
	{
		name: "ls",
		group: "Lease",
		summary: "list leases (resource, state, owner, repo/worktree, age, heartbeat)",
		load: async () => (await import("./ls")).lsCommand,
	},
	{
		name: "capacity",
		group: "Lease",
		summary: "machine capacity: budget, booted devices (foreign too), per-device cost, memory pressure",
		load: async () => (await import("./capacity")).capacityCommand,
	},
	{
		name: "queue",
		group: "Lease",
		summary: "claims waiting for host capacity, head first (position, priority, age, owner)",
		load: async () => (await import("./queue")).queueCommand,
	},
	{
		name: "devices",
		aliases: ["list"],
		group: "Devices",
		summary: "list every simulator / emulator (booted or not, plus Android AVDs) with warden ownership + leases",
		load: async () => (await import("./devices")).devicesCommand,
	},
	{
		name: "sim",
		group: "Devices",
		summary: "per-simulator tweaks: slim | profiles | measure | unquarantine",
		load: async () => (await import("./sim")).simCommand,
	},
	{
		name: "sims",
		group: "Devices",
		summary: "simulator + runtime disk audit (default), prune idle warden sims, delete (multi-select)",
		load: async () => (await import("./sims")).simsCommand,
	},
	{
		name: "arrange",
		group: "Devices",
		summary: "tile warden simulator windows in name order (macOS; also runs after iOS claims)",
		load: async () => (await import("./arrange")).arrangeCommand,
	},
	{
		name: "clone",
		group: "Devices",
		summary: "duplicate a shut-down iOS simulator into warden's pool (fast: no first boot)",
		load: async () => (await import("./clone")).cloneCommand,
	},
	{
		name: "golden",
		group: "Devices",
		summary: "golden iOS images / Android snapshots new devices start from (fast boots): ensure | ls | prune",
		load: async () => (await import("./golden")).goldenCommand,
	},
	{
		name: "check",
		group: "Lease",
		summary: "exit 0 if a device is free or yours, 2 if another owner holds it",
		load: async () => (await import("./check")).checkCommand,
	},
	{
		name: "heartbeat",
		group: "Lease",
		summary: "refresh lease heartbeats so they don't go stale",
		load: async () => (await import("./heartbeat")).heartbeatCommand,
	},
	{
		name: "gc",
		group: "Lease",
		summary: "reclaim stale leases; shut down idle warden devices (never deletes)",
		load: async () => (await import("./gc")).gcCommand,
	},
	{
		name: "port",
		group: "Lease",
		summary: "lease TCP ports from a range (bind-probed, never handed out twice)",
		load: async () => (await import("./port")).portCommand,
	},
	{
		name: "app",
		group: "Builds",
		summary: "fingerprint an Expo app and install the matching build (installed → cache → EAS → local build)",
		load: async () => (await import("./app")).appCommand,
	},
	{
		name: "repack",
		group: "Builds",
		summary:
			"bundle this worktree's JS into the cached simulator build (seconds; builds the base once per native fingerprint)",
		load: async () => (await import("./repack")).repackCommand,
	},
	{
		name: "ui",
		summary: "drive a leased simulator / emulator (agents): status, snapshot, find, open, press, fill, scroll, …",
		load: async () => (await import("./ui")).uiCommand,
	},
	{
		name: "__affected-graph",
		summary: "walk the import graph for `warden affected` and print it as JSON (internal)",
		hidden: true,
		load: async () => (await import("./affected-graph")).affectedGraphCommand,
	},
	{
		name: "__android-host",
		summary: "resident Android driver host behind `warden ui` (internal)",
		hidden: true,
		load: async () => (await import("./android-host")).androidHostCommand,
	},
	{
		name: "__ios-runner-host",
		summary: "resident iPhone runner host behind `warden ui` (internal)",
		hidden: true,
		load: async () => (await import("./ios-runner-host")).iosRunnerHostCommand,
	},
	{
		name: "__ios-runner-restart",
		summary: "restart an iPhone's runner host for a running e2e session (internal)",
		hidden: true,
		load: async () => (await import("./ios-runner-restart")).iosRunnerRestartCommand,
	},
	{
		name: "__netproxy",
		summary: "a lease's network shaping proxy, started by `warden ui net` (internal)",
		hidden: true,
		load: async () => (await import("./condition-processes")).netproxyCommand,
	},
	{
		name: "__route-ticker",
		summary: "the detached Android location route ticker (internal)",
		hidden: true,
		load: async () => (await import("./condition-processes")).routeTickerCommand,
	},
	{
		name: "__scheduler",
		summary: "the detached network flap / timeline scheduler (internal)",
		hidden: true,
		load: async () => (await import("./condition-processes")).schedulerCommand,
	},
	{
		name: "ui-collect",
		summary: "background console + network collector for `warden ui logs start` (internal)",
		hidden: true,
		load: async () => (await import("./ui-collect")).uiCollectCommand,
	},
	{
		name: "perf-collect",
		summary: "background sampler + auto-stop timer for `warden perf start` (internal)",
		hidden: true,
		load: async () => (await import("./perf-collect")).perfCollectCommand,
	},
	{
		name: "builds",
		group: "Builds",
		summary: "list, remove, prune (LRU) and import cached native app builds",
		load: async () => (await import("./builds")).buildsCommand,
	},
	{
		name: "hook",
		group: "Setup",
		summary: "Claude Code / Codex hook: on session end shut down what the session booted + release its leases",
		load: async () => (await import("./hook")).hookCommand,
	},
	{
		name: "install",
		group: "Setup",
		summary: "install warden to ~/.local/bin + hooks for detected agents (Claude Code: skill, rule, hook; Codex: hook)",
		load: async () => (await import("./install")).installCommand,
	},
	{
		name: "init",
		group: "Setup",
		summary: "set an Expo app up for warden dev / warden e2e (warden.config.ts, a first spec)",
		load: async () => (await import("./init")).initCommand,
	},
	{
		name: "completion",
		group: "Setup",
		summary: "print the tab-completion script for zsh / bash / fish (`warden install` sets it up)",
		load: async () => (await import("./completion")).completionCommand,
	},
	{
		name: "__complete",
		summary: "list completions for a partial command line (internal; used by `warden completion` scripts)",
		hidden: true,
		load: async () => (await import("./complete")).completeCommand,
	},
	{
		name: "skill",
		group: "Setup",
		summary: "the warden agent skill: show (copy/paste) | install (bunx/npx skills add)",
		load: async () => (await import("./skill")).skillCommand,
	},
	{
		name: "doctor",
		group: "Setup",
		summary:
			"check warden's setup: home, db, device tools, simulator helper, install method, PATH, Claude/Codex hooks + skill, stale leases",
		load: async () => (await import("./doctor")).doctorCommand,
	},
	{
		name: "update",
		group: "Setup",
		summary: "update warden: rebuild from source (dev/local builds) or install the latest release",
		load: async () => (await import("./update")).updateCommand,
	},
	{
		name: "version",
		group: "Setup",
		summary: "print warden's version and build channel (dev / local / release)",
		load: async () => (await import("./version")).versionCommand,
	},
	{
		name: "mcp",
		group: "Setup",
		summary: "MCP server on stdio: Metro logs, app console, network, eval, tree, logpoints, profiles of `warden dev`",
		load: async () => (await import("./mcp")).mcpCommand,
	},
	{
		name: "view",
		group: "Account",
		summary: "open a hosted device in the warden viewer window",
		load: async () => (await import("./view")).viewCommand,
	},
	{
		name: "login",
		group: "Account",
		summary: "log in to warden cloud (remote simulators) in the browser",
		load: async () => (await import("./login")).loginCommand,
	},
	{
		name: "logout",
		group: "Account",
		summary: "log out of warden cloud and forget the saved token",
		load: async () => (await import("./logout")).logoutCommand,
	},
	{
		name: "whoami",
		group: "Account",
		summary: "show the warden cloud account, organization, balance and remote-device status",
		load: async () => (await import("./whoami")).whoamiCommand,
	},
	{
		name: "billing",
		group: "Account",
		summary: "show the warden cloud balance and ledger, or top up credit",
		load: async () => (await import("./billing")).billingCommand,
	},
	{
		name: "org",
		group: "Account",
		summary: "list warden cloud organizations or switch the active one",
		load: async () => (await import("./org")).orgCommand,
	},
];
