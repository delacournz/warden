import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import type { CommandContext } from "../context";
import { androidHostDir, iosRunnerDir, simdDir, uiDir, uiRoot } from "./paths";

type Host = Pick<CommandContext, "env" | "now">;

/** The `state.json` fields that record a resident helper: iOS's `warden-simd`, Android's host, a physical iPhone's runner host. */
type HelperField = "helper" | "androidHost" | "iosRunner";

/** The pid of the helper `state.json` records under `field`, read as plain JSON: any other shape is no record. */
function recordedPid(
	host: Pick<CommandContext, "env">,
	udid: string,
	field: HelperField = "helper"
): number | undefined {
	try {
		const state: unknown = JSON.parse(readFileSync(join(uiDir(host, udid), "state.json"), "utf8"));
		if (typeof state !== "object" || state === null || !(field in state)) return undefined;
		const record: unknown = Reflect.get(state, field);
		if (typeof record !== "object" || record === null || !("pid" in record)) return undefined;
		return typeof record.pid === "number" ? record.pid : undefined;
	} catch {
		return undefined;
	}
}

/** Every device that has a socket under `simd/` or a dir under `ui/`. */
export function knownUdids(host: Pick<CommandContext, "env">): string[] {
	const udids = new Set<string>();
	for (const sockets of [simdDir(host), androidHostDir(host), iosRunnerDir(host)]) {
		if (!existsSync(sockets)) continue;
		for (const name of readdirSync(sockets)) if (name.endsWith(".sock")) udids.add(basename(name, ".sock"));
	}
	const root = uiRoot(host);
	if (existsSync(root)) for (const name of readdirSync(root)) udids.add(name);
	return [...udids];
}

/** Devices whose `state.json` records a helper pid that no longer runs (plain file reads: no schema, no driver). */
export function findDeadHelpers(host: Pick<CommandContext, "env">, pidAlive: PidAlive = processAlive): string[] {
	return knownUdids(host).filter((udid) =>
		(["helper", "androidHost", "iosRunner"] as const).some((field) => {
			const pid = recordedPid(host, udid, field);
			return pid !== undefined && !pidAlive(pid);
		})
	);
}

export type SweepDeps = {
	pidAlive?: PidAlive;
	/** loads `helper.ts`; tests count loads */
	load?: () => Promise<typeof import("./helper")>;
};

/**
 * `sweepDeadHelpers` for commands that must start fast (`gc`): the records are looked at first, and `./helper`
 * (the e2e iOS driver, its wire schemas and zod) is imported only when one names a helper that is gone.
 */
export async function sweepDeadHelpersLazily(host: Host, deps: SweepDeps = {}): Promise<string[]> {
	const pidAlive = deps.pidAlive ?? processAlive;
	if (findDeadHelpers(host, pidAlive).length === 0) return [];
	const { sweepDeadHelpers } = await (deps.load ?? (() => import("./helper")))();
	return sweepDeadHelpers(host, { pidAlive });
}

/**
 * Stop the resident Android host of each serial that has one recorded, before something else drives the emulator
 * (a `warden batch` / `warden e2e` job opens its own driver, and two `warden-uiad` clients evict each other). Records
 * are read as plain JSON; `./helper` is imported only when one exists, so a run with no host loads nothing.
 */
export async function stopAndroidHostsLazily(
	host: Host & Partial<Pick<CommandContext, "store">>,
	serials: readonly string[],
	deps: { load?: () => Promise<Pick<typeof import("./helper"), "stopAndroidHost">> } = {}
): Promise<string[]> {
	const recorded = serials.filter((serial) => recordedPid(host, serial, "androidHost") !== undefined);
	if (recorded.length === 0) return [];
	const { stopAndroidHost } = await (deps.load ?? (() => import("./helper")))();
	const warnings: string[] = [];
	for (const serial of recorded) {
		const { warning } = await stopAndroidHost(host, serial);
		if (warning !== undefined) warnings.push(warning);
	}
	return warnings;
}

/**
 * Stop the resident iPhone runner host of each physical UDID that has one recorded, before something else drives the
 * phone (two `xcodebuild` runner sessions on one device evict each other). Same shape as `stopAndroidHostsLazily`:
 * plain-JSON record check first, `./helper` imported only when one exists.
 */
export async function stopIosRunnersLazily(
	host: Host & Partial<Pick<CommandContext, "store">>,
	udids: readonly string[],
	deps: { load?: () => Promise<Pick<typeof import("./helper"), "stopIosRunner">> } = {}
): Promise<string[]> {
	const recorded = udids.filter((udid) => recordedPid(host, udid, "iosRunner") !== undefined);
	if (recorded.length === 0) return [];
	const { stopIosRunner } = await (deps.load ?? (() => import("./helper")))();
	const warnings: string[] = [];
	for (const udid of recorded) {
		const { warning } = await stopIosRunner(host, udid);
		if (warning !== undefined) warnings.push(warning);
	}
	return warnings;
}
