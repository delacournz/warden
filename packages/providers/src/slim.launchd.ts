import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-runtime/exec";

/**
 * Host-side helpers for slimming a booted simulator in bulk: where the sim runtime's launchd plists
 * live, and which plist belongs to which label. `launchctl unload -w <plist…>` takes dozens of jobs
 * per spawn where `disable` + `bootout` takes two spawns per job.
 */

type JsonObject = Record<string, unknown>;

const PLIST_DIRS = ["System/Library/LaunchDaemons", "System/Library/LaunchAgents"] as const;
const PLIST_LOOKUP_CONCURRENCY = 16;

/** Reads `simctl list runtimes|devices -j` for the runtime a simulator runs on. */
export class LaunchdParser {
	/** `simctl list runtimes -j` → the RuntimeRoot directory of `runtimeId` (its `runtimeRoot`, else derived from `bundlePath`). */
	parseRuntimeRoot(simctlListRuntimesJson: string, runtimeId: string): string | undefined {
		const data = this.parseObject(simctlListRuntimesJson);
		if (data === undefined || !Array.isArray(data.runtimes)) return undefined;
		for (const entry of data.runtimes as unknown[]) {
			if (!this.isObject(entry) || entry.identifier !== runtimeId) continue;
			if (typeof entry.runtimeRoot === "string" && entry.runtimeRoot !== "") return entry.runtimeRoot;
			if (typeof entry.bundlePath === "string" && entry.bundlePath !== "")
				return join(entry.bundlePath, "Contents", "Resources", "RuntimeRoot");
		}
		return undefined;
	}

	/** `simctl list devices -j` → the runtime key (`com.apple.CoreSimulator.SimRuntime.iOS-27-1`) `udid` is listed under. */
	parseDeviceRuntime(simctlListDevicesJson: string, udid: string): string | undefined {
		const data = this.parseObject(simctlListDevicesJson);
		if (data === undefined || !this.isObject(data.devices)) return undefined;
		for (const [runtimeId, list] of Object.entries(data.devices)) {
			if (Array.isArray(list) && list.some((entry) => this.isObject(entry) && entry.udid === udid)) return runtimeId;
		}
		return undefined;
	}

	/** `items` in consecutive slices of at most `size`. */
	chunk<T>(items: readonly T[], size: number): T[][] {
		const out: T[][] = [];
		for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
		return out;
	}

	private isObject(value: unknown): value is JsonObject {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private parseObject(stdout: string): JsonObject | undefined {
		try {
			const value: unknown = JSON.parse(stdout);
			return this.isObject(value) ? value : undefined;
		} catch {
			return undefined;
		}
	}
}

export const launchdParser = new LaunchdParser();

/** Finds the launchd plists of a simulator runtime through `exec`. */
export class LaunchdPlists {
	constructor(
		private readonly exec: Exec,
		/** plist existence probe (default `node:fs`) */
		private readonly fileExists: (path: string) => boolean = existsSync
	) {}

	/** RuntimeRoot of the runtime `runtimeId` via `simctl list runtimes -j`; undefined when simctl or the JSON gives none. */
	async runtimeRootFor(runtimeId: string): Promise<string | undefined> {
		const res = await this.exec(["xcrun", "simctl", "list", "runtimes", "-j"]);
		return res.exitCode === 0 ? launchdParser.parseRuntimeRoot(res.stdout, runtimeId) : undefined;
	}

	/** RuntimeRoot of the runtime a simulator runs on; undefined when it cannot be found (callers fall back to per-label). */
	async runtimeRootForDevice(udid: string): Promise<string | undefined> {
		const listed = await this.exec(["xcrun", "simctl", "list", "devices", "-j"]);
		if (listed.exitCode !== 0) return undefined;
		const runtimeId = launchdParser.parseDeviceRuntime(listed.stdout, udid);
		return runtimeId === undefined ? undefined : this.runtimeRootFor(runtimeId);
	}

	/**
	 * label → plist path under `root`. A plist counts only when its own `Label` (read with
	 * `plutil -extract Label raw`) equals the label asked for, so a renamed or shared file can never
	 * unload a daemon outside the allowlist. Labels without a verified plist are absent from the map.
	 */
	async jobPlists(root: string, labels: readonly string[]): Promise<Map<string, string>> {
		const found = new Map<string, string>();
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < labels.length) await this.lookup(root, labels[next++] as string, found);
		};
		await Promise.all(Array.from({ length: Math.min(PLIST_LOOKUP_CONCURRENCY, labels.length) }, worker));
		return found;
	}

	private async lookup(root: string, label: string, found: Map<string, string>): Promise<void> {
		for (const dir of PLIST_DIRS) {
			const path = join(root, dir, `${label}.plist`);
			if (!this.fileExists(path)) continue;
			const res = await this.exec(["plutil", "-extract", "Label", "raw", "-o", "-", path]);
			if (res.exitCode === 0 && res.stdout.trim() === label) {
				found.set(label, path);
				return;
			}
		}
	}
}
