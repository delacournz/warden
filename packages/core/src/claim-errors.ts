/**
 * The machine codes a failed device claim carries, with the exit code the CLI returns for each and a short fix.
 * A claim error travels as a string (`Result<…, string>`) through every claim caller, so the code rides at its
 * front (`NO_DEVICE: …`, `NO_CAPACITY[ram-budget]: …`) and `parseClaimError` reads it back where it is reported.
 */

/** Why the host has no room for the boots a claim needs. */
export type CapacityReason = "ram-budget" | "cpu-budget" | "memory-pressure" | "host-load";

export type ClaimErrorCode =
	| "QUEUE_TIMEOUT"
	| "NO_CAPACITY"
	| "NO_DEVICE"
	| "REQUESTER_LIMIT"
	| "RUNTIME_MISSING"
	| "HEALTH_FAILED"
	| "LEASE_LOST";

/** What a claim error says: its code, and for `NO_CAPACITY` which resource ran out. */
export type ClaimErrorKind =
	| { code: "NO_CAPACITY"; capacityReason: CapacityReason }
	| { code: Exclude<ClaimErrorCode, "NO_CAPACITY"> };

export type ClaimErrorEntry = { exit: number; hint: string };

/**
 * Exit codes 5-11 are claim failures; 1 stays the generic failure, 2 someone else's device / an ambiguous pick,
 * 3 a missing tool, 4 a stale ref, 124 a timed-out job and 130 an interrupt.
 */
export const CLAIM_ERRORS: Record<ClaimErrorCode, ClaimErrorEntry> = {
	NO_DEVICE: {
		exit: 5,
		hint: "every matching device is leased at --max: wait (--wait 10m), raise --max, or release one (warden ls, warden release <leaseId>)",
	},
	QUEUE_TIMEOUT: {
		exit: 6,
		hint: "timed out behind higher-priority claims in the boot queue: wait longer (--wait 30m), raise --priority, or see warden queue",
	},
	NO_CAPACITY: {
		exit: 7,
		hint: "the host has no room to boot another device: release idle leases (warden ls), shut down idle devices (warden gc), or see warden capacity",
	},
	REQUESTER_LIMIT: {
		exit: 8,
		hint: "this owner already holds its limit of separate claims (WARDEN_MAX_PER_OWNER): release one with warden release <leaseId>",
	},
	RUNTIME_MISSING: {
		exit: 9,
		hint: "no installed runtime / system image matches the profile: install it (Xcode > Settings > Components, or sdkmanager), or pick another --profile",
	},
	HEALTH_FAILED: {
		exit: 10,
		hint: "devices kept failing their post-boot health probe and were quarantined: retry, or see warden devices / warden sim unquarantine",
	},
	LEASE_LOST: {
		exit: 11,
		hint: "another process released this run's lease (warden release, SessionEnd) or its device died: claim again",
	},
};

const CODES = new Set<string>(Object.keys(CLAIM_ERRORS));
const CAPACITY_REASONS = new Set<string>(["ram-budget", "cpu-budget", "memory-pressure", "host-load"]);
const isCode = (s: string): s is ClaimErrorCode => CODES.has(s);
const isCapacityReason = (s: string): s is CapacityReason => CAPACITY_REASONS.has(s);

/** `NO_DEVICE: <message>` / `NO_CAPACITY[ram-budget]: <message>`. */
export function claimError(kind: ClaimErrorKind, message: string): string {
	const tag = kind.code === "NO_CAPACITY" ? `${kind.code}[${kind.capacityReason}]` : kind.code;
	return `${tag}: ${message}`;
}

/** A claim error read back from its message: the code, its exit code and hint, and the message without the tag. */
export type ParsedClaimError = ClaimErrorKind & ClaimErrorEntry & { message: string };

const TAG = /^([A-Z_]+)(?:\[([a-z-]+)\])?: ([\s\S]*)$/;

/** The coded claim error at the front of `error`, or undefined for an uncoded failure. */
export function parseClaimError(error: string): ParsedClaimError | undefined {
	const match = TAG.exec(error);
	const [, code, reason, message] = match ?? [];
	if (code === undefined || message === undefined || !isCode(code)) return undefined;
	const entry = CLAIM_ERRORS[code];
	if (code === "NO_CAPACITY") {
		if (reason === undefined || !isCapacityReason(reason)) return undefined;
		return { code, capacityReason: reason, message, ...entry };
	}
	if (reason !== undefined) return undefined;
	return { code, message, ...entry };
}

/** Provider create errors that mean the runtime / system image the profile needs is not installed. */
const RUNTIME_MISSING_ERRORS = [
	/^no available iOS runtime matching/,
	/^no iOS runtime matching/,
	/^no AVD matches profile/,
];

/** Is this provider error a missing runtime / AVD (`RUNTIME_MISSING`)? */
export const isRuntimeMissing = (error: string): boolean => RUNTIME_MISSING_ERRORS.some((re) => re.test(error));
