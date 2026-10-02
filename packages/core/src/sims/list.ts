/**
 * The one listing of simulators on the machine: `simctl list devices -j` (NOT `available`, so sims
 * whose runtime was removed are still seen), sized by simctl's `dataPathSize`, else `du -sk`.
 * Used by goldens, `warden clone`, and every `warden sims` subcommand.
 */
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";

/** A sim from `simctl list devices -j` (all, including unavailable). */
export type SimctlSim = {
	udid: string;
	name: string;
	state: string;
	isAvailable: boolean;
	runtimeId: string;
	deviceTypeIdentifier?: string;
	/** `<CoreSimulator>/Devices/<udid>/data` */
	dataPath?: string;
	/** bytes simctl reports for `dataPath` (the bulk of a sim's footprint) */
	dataPathSize?: number;
	/** epoch ms of the last boot, when simctl reports it */
	lastBootedAt?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSimctlSim(entry: unknown, runtimeId: string): SimctlSim | undefined {
	if (!isRecord(entry) || typeof entry.udid !== "string" || typeof entry.name !== "string") return undefined;
	const sim: SimctlSim = {
		udid: entry.udid,
		name: entry.name,
		state: typeof entry.state === "string" ? entry.state : "Unknown",
		isAvailable: entry.isAvailable !== false,
		runtimeId,
	};
	if (typeof entry.deviceTypeIdentifier === "string") sim.deviceTypeIdentifier = entry.deviceTypeIdentifier;
	if (typeof entry.dataPath === "string") sim.dataPath = entry.dataPath;
	if (typeof entry.dataPathSize === "number") sim.dataPathSize = entry.dataPathSize;
	const booted = typeof entry.lastBootedAt === "string" ? Date.parse(entry.lastBootedAt) : Number.NaN;
	if (!Number.isNaN(booted)) sim.lastBootedAt = booted;
	return sim;
}

/** `simctl list devices -j`. iOS only unless `allPlatforms` (watchOS/tvOS/visionOS sims too, for `warden sims`). */
export function parseAllSims(stdout: string, opts: { allPlatforms?: boolean } = {}): Result<SimctlSim[]> {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return err("simctl list devices: invalid JSON");
	}
	if (!isRecord(data) || !isRecord(data.devices)) return err("simctl list devices: missing `devices`");
	const sims: SimctlSim[] = [];
	for (const [runtimeId, list] of Object.entries(data.devices)) {
		if ((!opts.allPlatforms && !runtimeId.includes(".iOS-")) || !Array.isArray(list)) continue;
		for (const entry of list) {
			const sim = toSimctlSim(entry, runtimeId);
			if (sim) sims.push(sim);
		}
	}
	return ok(sims);
}

async function run(exec: Exec, cmd: string[]): AsyncResult<string> {
	const result = await exec(cmd);
	return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
}

/** `du -sk` → bytes; undefined when du fails (e.g. the data dir is gone). */
async function duBytes(exec: Exec, path: string): Promise<number | undefined> {
	const out = await run(exec, ["du", "-sk", path]);
	const kb = out.success ? Number.parseInt(out.data, 10) : Number.NaN;
	return Number.isNaN(kb) ? undefined : kb * 1024;
}

/** Every sim on the machine (all platforms, unavailable included), sized by simctl's `dataPathSize`, else `du`. */
export async function listAllSims(exec: Exec): AsyncResult<SimctlSim[]> {
	const out = await run(exec, ["xcrun", "simctl", "list", "devices", "-j"]);
	if (!out.success) return out;
	const sims = parseAllSims(out.data, { allPlatforms: true });
	if (!sims.success) return sims;
	for (const sim of sims.data) {
		if (sim.dataPathSize !== undefined || sim.dataPath === undefined) continue;
		const bytes = await duBytes(exec, sim.dataPath);
		if (bytes !== undefined) sim.dataPathSize = bytes;
	}
	return sims;
}
