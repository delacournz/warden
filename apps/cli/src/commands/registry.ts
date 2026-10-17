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
		summary: "list the e2e flows a change needs (git diff vs base → import graph → flows)",
		load: async () => (await import("./affected")).affectedCommand,
	},
	{
		name: "e2e",
		group: "Run",
		summary: "run the e2e flows a change needs on leased devices; exit 1 if a required flow fails",
		load: async () => (await import("./e2e")).e2eCommand,
	},
	{
		name: "ls",
		group: "Lease",
		summary: "list leases (resource, state, owner, repo/worktree, age, heartbeat)",
		load: async () => (await import("./ls")).lsCommand,
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
		summary: "per-simulator tweaks: slim | unquarantine",
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
		name: "ui-collect",
		summary: "background console + network collector for `warden ui logs start` (internal)",
		hidden: true,
		load: async () => (await import("./ui-collect")).uiCollectCommand,
	},
	{
		name: "builds",
		group: "Builds",
		summary: "list, prune (LRU) and import cached native app builds",
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
];
