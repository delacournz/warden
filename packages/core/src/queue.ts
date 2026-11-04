import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CapacityReason } from "./claim-errors";
import type { QueueEntry } from "./types";

export const PRIORITY = { interactive: 30, high: 20, normal: 10, low: 0 } as const;

export type PriorityName = keyof typeof PRIORITY;

/** `high` for 20, the number itself for a custom priority. */
export const priorityName = (priority: number): string =>
	Object.entries(PRIORITY).find(([, value]) => value === priority)?.[0] ?? String(priority);

/** Gap between adjacent named priorities (`low` → `normal` → `high` → `interactive`). */
export const PRIORITY_STEP = 10;

/**
 * One priority level (`PRIORITY_STEP` points) is earned per this much waiting, so a `low` row overtakes
 * a fresh `high` one after 20 min, inside the default 30 min `--wait`.
 */
export const AGING_MS = 10 * 60_000;

export function parsePriority(input: string): Result<number> {
	const name = input.trim().toLowerCase();
	if (/^\d+$/.test(name)) return ok(Number(name));
	if (name in PRIORITY) return ok(PRIORITY[name as PriorityName]);
	return err(`unknown priority "${input}" (use ${Object.keys(PRIORITY).join("|")} or a non-negative integer)`);
}

/** `priority + PRIORITY_STEP × floor(age / 10 min)`; clock skew (now < enqueuedAt) earns nothing. */
export function effectivePriority(entry: QueueEntry, now: number): number {
	return entry.priority + PRIORITY_STEP * Math.floor(Math.max(0, now - entry.enqueuedAt) / AGING_MS);
}

/** Head first: effective priority desc, then enqueued_at asc, then id. */
export function queueOrder(entries: readonly QueueEntry[], now: number): QueueEntry[] {
	return [...entries].sort(
		(a, b) =>
			effectivePriority(b, now) - effectivePriority(a, now) ||
			a.enqueuedAt - b.enqueuedAt ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

/** 1-based position, or undefined when `id` is not queued. */
export function queuePosition(entries: readonly QueueEntry[], id: string, now: number): number | undefined {
	const index = queueOrder(entries, now).findIndex((e) => e.id === id);
	return index === -1 ? undefined : index + 1;
}

export function isHead(entries: readonly QueueEntry[], id: string, now: number): boolean {
	return queuePosition(entries, id, now) === 1;
}

/** Why a polling claim has no device yet although the host has room: nothing to reserve. */
export const DEVICE_WAIT_REASONS = ["device-limit", "requester-limit", "waiting-for-device"] as const;

export type DeviceWaitReason = (typeof DEVICE_WAIT_REASONS)[number];

/**
 * Why a claim is not running yet. Queued for host capacity: behind an earlier claim, or the resource the
 * host is out of. Polling for a device: the pool is at `--max`, the owner is at its limit, or a physical
 * device is not free / ready.
 */
export type WaitReason = "behind-earlier" | CapacityReason | DeviceWaitReason;

const WAIT_REASONS: ReadonlySet<string> = new Set<WaitReason>([
	"behind-earlier",
	"ram-budget",
	"cpu-budget",
	"memory-pressure",
	"host-load",
	...DEVICE_WAIT_REASONS,
]);

export const isWaitReason = (s: string): s is WaitReason => WAIT_REASONS.has(s);

export const isDeviceWaitReason = (reason: WaitReason | undefined): reason is DeviceWaitReason =>
	reason !== undefined && (DEVICE_WAIT_REASONS as readonly string[]).includes(reason);

/**
 * Rows that take part in admission order. A claim polling for a device holds a row so `warden queue` can
 * show why it waits, but it needs no boot slot: it is never ahead of, or counted against, a claim that does.
 */
export const admissionQueue = (entries: readonly QueueEntry[]): QueueEntry[] =>
	entries.filter((e) => !isDeviceWaitReason(e.reason));
