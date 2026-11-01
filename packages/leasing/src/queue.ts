import type { QueueEntry } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";

export const PRIORITY = { interactive: 30, high: 20, normal: 10, low: 0 } as const;

export type PriorityName = keyof typeof PRIORITY;

/** Gap between adjacent named priorities (`low` → `normal` → `high` → `interactive`). */
export const PRIORITY_STEP = 10;

/**
 * One priority level (`PRIORITY_STEP` points) is earned per this much waiting, so a `low` row overtakes
 * a fresh `high` one after 20 min, inside the default 30 min `--wait`.
 */
export const AGING_MS = 10 * 60_000;

export class QueueOrdering {
	/** `high` for 20, the number itself for a custom priority. */
	priorityName(priority: number): string {
		return Object.entries(PRIORITY).find(([, value]) => value === priority)?.[0] ?? String(priority);
	}

	parsePriority(input: string): Result<number, WardenError> {
		const name = input.trim().toLowerCase();
		if (/^\d+$/.test(name)) return resultFactory.ok(Number(name));
		if (name in PRIORITY) return resultFactory.ok(PRIORITY[name as PriorityName]);
		return wardenErrors.err(
			"usage",
			`unknown priority "${input}" (use ${Object.keys(PRIORITY).join("|")} or a non-negative integer)`
		);
	}

	/** `priority + PRIORITY_STEP × floor(age / 10 min)`; clock skew (now < enqueuedAt) earns nothing. */
	effectivePriority(entry: QueueEntry, now: number): number {
		return entry.priority + PRIORITY_STEP * Math.floor(Math.max(0, now - entry.enqueuedAt) / AGING_MS);
	}

	/** Head first: effective priority desc, then enqueued_at asc, then id. */
	order(entries: readonly QueueEntry[], now: number): QueueEntry[] {
		return [...entries].sort(
			(a, b) =>
				this.effectivePriority(b, now) - this.effectivePriority(a, now) ||
				a.enqueuedAt - b.enqueuedAt ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
		);
	}

	/** 1-based position, or undefined when `id` is not queued. */
	position(entries: readonly QueueEntry[], id: string, now: number): number | undefined {
		const index = this.order(entries, now).findIndex((e) => e.id === id);
		return index === -1 ? undefined : index + 1;
	}

	isHead(entries: readonly QueueEntry[], id: string, now: number): boolean {
		return this.position(entries, id, now) === 1;
	}
}

export const queueOrdering = new QueueOrdering();
