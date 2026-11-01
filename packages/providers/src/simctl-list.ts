/**
 * The one listing of simulators on the machine: `simctl list devices -j` (NOT `available`, so sims
 * whose runtime was removed are still seen), sized by simctl's `dataPathSize`, else `du -sk`.
 * Used by goldens, `warden clone`, and every `warden sims` subcommand.
 */

import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";

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

/** Reads `simctl list devices -j`. */
export class SimctlListParser {
	/** `simctl list devices -j`. iOS only unless `allPlatforms` (watchOS/tvOS/visionOS sims too, for `warden sims`). */
	parseAll(stdout: string, opts: { allPlatforms?: boolean } = {}): Result<SimctlSim[], WardenError> {
		let data: unknown;
		try {
			data = JSON.parse(stdout);
		} catch {
			return wardenErrors.err("failed", "simctl list devices: invalid JSON");
		}
		if (!this.isRecord(data) || !this.isRecord(data.devices))
			return wardenErrors.err("failed", "simctl list devices: missing `devices`");
		const sims: SimctlSim[] = [];
		for (const [runtimeId, list] of Object.entries(data.devices)) {
			if ((!opts.allPlatforms && !runtimeId.includes(".iOS-")) || !Array.isArray(list)) continue;
			for (const entry of list) {
				const sim = this.toSim(entry, runtimeId);
				if (sim) sims.push(sim);
			}
		}
		return resultFactory.ok(sims);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private toSim(entry: unknown, runtimeId: string): SimctlSim | undefined {
		if (!this.isRecord(entry) || typeof entry.udid !== "string" || typeof entry.name !== "string") return undefined;
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
}

export const simctlListParser = new SimctlListParser();

/** Lists every simulator on the machine through `exec`. */
export class SimctlLister {
	constructor(private readonly exec: Exec) {}

	/** Every sim on the machine (all platforms, unavailable included), sized by simctl's `dataPathSize`, else `du`. */
	async listAll(): AsyncResult<SimctlSim[]> {
		const out = await this.run(["xcrun", "simctl", "list", "devices", "-j"]);
		if (!out.success) return out;
		const sims = simctlListParser.parseAll(out.data, { allPlatforms: true });
		if (!sims.success) return resultFactory.err(sims.error.message);
		for (const sim of sims.data) {
			if (sim.dataPathSize !== undefined || sim.dataPath === undefined) continue;
			const bytes = await this.duBytes(sim.dataPath);
			if (bytes !== undefined) sim.dataPathSize = bytes;
		}
		return sims;
	}

	private async run(cmd: string[]): AsyncResult<string> {
		const result = await this.exec(cmd);
		return result.exitCode === 0 ? resultFactory.ok(result.stdout) : resultFactory.err(execErrors.format(cmd, result));
	}

	/** `du -sk` → bytes; undefined when du fails (e.g. the data dir is gone). */
	private async duBytes(path: string): Promise<number | undefined> {
		const out = await this.run(["du", "-sk", path]);
		const kb = out.success ? Number.parseInt(out.data, 10) : Number.NaN;
		return Number.isNaN(kb) ? undefined : kb * 1024;
	}
}
