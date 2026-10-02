/**
 * Disk audit of installed simulator runtimes (`simctl runtime list -j`, Xcode 15+): size, how many
 * sims use each one, and which are unused. Runtimes are machine-wide and not warden's, so this is
 * report-only — the user deletes one with `xcrun simctl runtime delete <identifier>`.
 */
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { shortRuntime } from "../providers/ios";
import type { SimEntry } from "./rules";

export type DiskRuntime = {
	/** disk image UUID — what `simctl runtime delete` takes */
	identifier: string;
	/** e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-5` — what sims reference */
	runtimeIdentifier: string;
	/** short runtime, e.g. `iOS-26-5` */
	runtime: string;
	version: string;
	build: string;
	sizeBytes: number;
	state: string;
	/** false for runtimes simctl won't delete (e.g. bundled with Xcode) */
	deletable: boolean;
	/** epoch ms */
	lastUsedAt?: number;
};

export type RuntimeVerdict =
	| { kind: "in-use" }
	/** only warden sims the sim audit marks `delete` use it */
	| { kind: "unused-after-prune" }
	| { kind: "unused" }
	/** unused, but simctl won't delete it */
	| { kind: "protected" };

export type RuntimeAuditEntry = DiskRuntime & { sims: number; wardenSims: number; verdict: RuntimeVerdict };

export type RuntimeAudit = {
	entries: RuntimeAuditEntry[];
	totalBytes: number;
	/** deletable runtimes no sim uses */
	unusedBytes: number;
	/** deletable runtimes only `delete`-verdict warden sims use */
	unusedAfterPruneBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRuntime(entry: unknown): DiskRuntime | undefined {
	if (!isRecord(entry)) return undefined;
	const { identifier, runtimeIdentifier, sizeBytes } = entry;
	if (typeof identifier !== "string" || typeof runtimeIdentifier !== "string" || typeof sizeBytes !== "number")
		return undefined;
	const runtime: DiskRuntime = {
		identifier,
		runtimeIdentifier,
		runtime: shortRuntime(runtimeIdentifier),
		version: typeof entry.version === "string" ? entry.version : "",
		build: typeof entry.build === "string" ? entry.build : "",
		sizeBytes,
		state: typeof entry.state === "string" ? entry.state : "Unknown",
		deletable: entry.deletable === true,
	};
	const used = typeof entry.lastUsedAt === "string" ? Date.parse(entry.lastUsedAt) : Number.NaN;
	if (!Number.isNaN(used)) runtime.lastUsedAt = used;
	return runtime;
}

/** `simctl runtime list -j`: an object keyed by disk image UUID. */
export function parseRuntimeList(stdout: string): Result<DiskRuntime[]> {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return err("simctl runtime list: invalid JSON");
	}
	if (!isRecord(data)) return err("simctl runtime list: expected an object");
	return ok(Object.values(data).flatMap((entry) => toRuntime(entry) ?? []));
}

export async function listDiskRuntimes(exec: Exec): AsyncResult<DiskRuntime[]> {
	const cmd = ["xcrun", "simctl", "runtime", "list", "-j"];
	const result = await exec(cmd);
	return result.exitCode === 0 ? parseRuntimeList(result.stdout) : err(execError(cmd, result));
}

function verdictFor(runtime: DiskRuntime, users: readonly SimEntry[]): RuntimeVerdict {
	if (users.length === 0) return runtime.deletable ? { kind: "unused" } : { kind: "protected" };
	const allGoing = users.every((s) => s.verdict.kind === "delete");
	return allGoing && runtime.deletable ? { kind: "unused-after-prune" } : { kind: "in-use" };
}

export function auditRuntimes(runtimes: readonly DiskRuntime[], sims: readonly SimEntry[]): RuntimeAudit {
	const entries = runtimes.map((runtime): RuntimeAuditEntry => {
		const users = sims.filter((s) => s.runtimeId === runtime.runtimeIdentifier);
		return {
			...runtime,
			sims: users.length,
			wardenSims: users.filter((s) => s.owner === "warden").length,
			verdict: verdictFor(runtime, users),
		};
	});
	entries.sort((a, b) => b.sizeBytes - a.sizeBytes || a.runtime.localeCompare(b.runtime));
	const bytesOf = (kind: RuntimeVerdict["kind"]) =>
		entries.filter((e) => e.verdict.kind === kind).reduce((s, e) => s + e.sizeBytes, 0);
	return {
		entries,
		totalBytes: entries.reduce((s, e) => s + e.sizeBytes, 0),
		unusedBytes: bytesOf("unused"),
		unusedAfterPruneBytes: bytesOf("unused") + bytesOf("unused-after-prune"),
	};
}
