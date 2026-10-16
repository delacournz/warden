import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Platform } from "../results/schema";
import { type Exec, runOk } from "./exec";

/** A device the run uses; `leaseId` is set only when this harness claimed it (and so must release it). */
export type ClaimedDevice = { udid: string; leaseId?: string; name?: string; runtime?: string };

export type ClaimInput = {
	platform: Platform;
	/** `apps/cli/src/cli.ts`: this checkout's warden, not whatever is on PATH */
	cliPath: string;
	repoRoot: string;
	/** a device the caller already leased: no claim, the lease stays theirs */
	udid?: string;
	log: (line: string) => void;
};

/** The first lease of `warden claim --json` (`{leases:[{leaseId,udid,name?}],udids,reclaimed}`). */
export function parseClaim(stdout: string): { leaseId: string; udid: string; name?: string } | undefined {
	try {
		const raw: unknown = JSON.parse(stdout);
		const leases: unknown = typeof raw === "object" && raw !== null && "leases" in raw ? raw.leases : undefined;
		const first: unknown = Array.isArray(leases) ? leases[0] : undefined;
		if (typeof first !== "object" || first === null) return undefined;
		if (!("leaseId" in first) || !("udid" in first)) return undefined;
		const { leaseId, udid } = first;
		if (typeof leaseId !== "string" || typeof udid !== "string") return undefined;
		const name = "name" in first && typeof first.name === "string" ? first.name : undefined;
		return { leaseId, udid, ...(name !== undefined ? { name } : {}) };
	} catch {
		return undefined;
	}
}

/**
 * Claims a device through warden unless the caller passed one. With an explicit udid nothing is claimed
 * and no lease id is returned, so `releaseDevice` is never called on a device the caller owns.
 */
export async function claimDevice(exec: Exec, input: ClaimInput): AsyncResult<ClaimedDevice> {
	if (input.udid !== undefined) {
		input.log(`using caller-leased device ${input.udid}`);
		return ok({ udid: input.udid });
	}
	const ran = await runOk(exec, process.execPath, [input.cliPath, "claim", input.platform, "--json"], {
		cwd: input.repoRoot,
		onLine: (_s, line) => input.log(line),
	});
	if (!ran.success) return ran;
	const claim = parseClaim(ran.data.stdout);
	if (claim === undefined) return err(`warden claim: unparseable output: ${ran.data.stdout.slice(0, 200)}`);
	return ok({ udid: claim.udid, leaseId: claim.leaseId, ...(claim.name !== undefined ? { name: claim.name } : {}) });
}

/** Releases exactly one lease id. Never `--mine`: agents of one session share the session id. */
export async function releaseDevice(
	exec: Exec,
	input: { cliPath: string; leaseId: string; repoRoot?: string }
): AsyncResult<void> {
	const ran = await runOk(exec, process.execPath, [input.cliPath, "release", input.leaseId], {
		...(input.repoRoot !== undefined ? { cwd: input.repoRoot } : {}),
	});
	return ran.success ? ok(undefined) : ran;
}

/** Name of the device with `udid` in one runtime's device list. */
function findName(list: unknown, udid: string): string | undefined {
	if (!Array.isArray(list)) return undefined;
	for (const d of list as unknown[]) {
		if (typeof d !== "object" || d === null) continue;
		if ("udid" in d && d.udid === udid && "name" in d && typeof d.name === "string") return d.name;
	}
	return undefined;
}

/** Finds `udid` in `xcrun simctl list devices --json` and returns its name and runtime (e.g. "iOS 18.2"). */
export function parseSimctlDevices(stdout: string, udid: string): { name: string; runtime?: string } | undefined {
	let groups: unknown;
	try {
		const raw: unknown = JSON.parse(stdout);
		groups = typeof raw === "object" && raw !== null && "devices" in raw ? raw.devices : undefined;
	} catch {
		return undefined;
	}
	if (typeof groups !== "object" || groups === null) return undefined;
	for (const [runtimeKey, list] of Object.entries(groups)) {
		const name = findName(list, udid);
		if (name === undefined) continue;
		const runtime = runtimeLabel(runtimeKey);
		return { name, ...(runtime !== undefined ? { runtime } : {}) };
	}
	return undefined;
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-2` to `iOS 18.2`. */
function runtimeLabel(key: string): string | undefined {
	const m = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(key);
	if (m?.[1] === undefined || m[2] === undefined) return undefined;
	return `${m[1]} ${m[2].replaceAll("-", ".")}`;
}

async function prop(exec: Exec, serial: string, name: string): Promise<string | undefined> {
	const r = await exec.run("adb", ["-s", serial, "shell", "getprop", name]);
	const v = r.stdout.trim();
	return r.code === 0 && v !== "" ? v : undefined;
}

/** Device name and OS version for the results file; best effort, so a miss is an empty object, not an error. */
export async function deviceInfo(
	exec: Exec,
	platform: Platform,
	udid: string
): AsyncResult<{ name?: string; runtime?: string }> {
	if (platform === "ios") {
		const r = await runOk(exec, "xcrun", ["simctl", "list", "devices", "--json"]);
		if (!r.success) return r;
		return ok(parseSimctlDevices(r.data.stdout, udid) ?? {});
	}
	const [model, release] = await Promise.all([
		prop(exec, udid, "ro.product.model"),
		prop(exec, udid, "ro.build.version.release"),
	]);
	return ok({
		...(model !== undefined ? { name: model } : {}),
		...(release !== undefined ? { runtime: `Android ${release}` } : {}),
	});
}
