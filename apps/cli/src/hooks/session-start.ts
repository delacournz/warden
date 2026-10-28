import { formatSize } from "@delacour/warden-core/builds/prune";
import type { DiskFacts, DiskVerdict } from "@delacour/warden-core/disk";
import type { Store } from "@delacour/warden-core/store";

/** store meta key holding the last rendered line (or none) and when it was read */
export const SESSION_START_META_KEY = "disk_hint";
/** A busy machine opens many sessions: the verdict is reused for this long. */
export const SESSION_START_CACHE_MS = 60_000;

export type SessionStartDeps = {
	store: () => Store;
	now: () => number;
	/** `WARDEN_DISK=off` */
	enabled: boolean;
	readDisk: () => Promise<{ facts: DiskFacts; verdict: DiskVerdict }>;
};

type Cached = { at: number; line: string | null };

function readCache(store: Store, now: number): Cached | undefined {
	try {
		const raw = store.getMeta(SESSION_START_META_KEY);
		if (raw === undefined) return undefined;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const at: unknown = Reflect.get(parsed, "at");
		const line: unknown = Reflect.get(parsed, "line");
		if (typeof at !== "number" || now - at >= SESSION_START_CACHE_MS || now < at) return undefined;
		if (typeof line === "string" || line === null) return { at, line };
		return undefined;
	} catch {
		return undefined;
	}
}

/** The one line an agent starts a session with when the disk or swap is under pressure; null when all is well. */
export function diskHint(facts: DiskFacts, verdict: DiskVerdict): string | null {
	if (verdict.level === "ok") return null;
	const parts: string[] = [];
	for (const reason of verdict.reasons) {
		if (reason.kind === "low-free") parts.push(`disk ${formatSize(reason.freeBytes)} free`);
		else if (reason.kind === "swap") parts.push(`swap ${formatSize(reason.swapUsedBytes)}`);
		else if (reason.kind === "os-update-snapshots") parts.push(`${reason.count} OS-update snapshot(s)`);
		else if (reason.kind === "tm-snapshots") parts.push(`${reason.count} Time Machine snapshot(s)`);
		else parts.push(`up ${reason.days} days`);
	}
	const shown = parts.length > 0 ? parts.join(", ") : `disk ${formatSize(facts.freeBytes ?? 0)} free`;
	return `warden: ${shown} — reuse booted devices, avoid parallel builds; see \`warden disk\``;
}

/**
 * SessionStart: the hint line for the agent, or undefined for nothing. Never throws. The rendered line is
 * cached in the store for `SESSION_START_CACHE_MS`, so most sessions cost one meta read.
 */
export async function handleSessionStart(deps: SessionStartDeps): Promise<string | undefined> {
	if (!deps.enabled) return undefined;
	try {
		const now = deps.now();
		const store = deps.store();
		const cached = readCache(store, now);
		if (cached) return cached.line ?? undefined;
		const { facts, verdict } = await deps.readDisk();
		const line = diskHint(facts, verdict);
		store.setMeta(SESSION_START_META_KEY, JSON.stringify({ at: now, line } satisfies Cached));
		return line ?? undefined;
	} catch {
		return undefined;
	}
}
