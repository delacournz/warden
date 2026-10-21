/**
 * A bounded, lock-aware task pool — how `signoff.ts` runs its checks side by side.
 *
 * `limit` caps how many run at once. `locks` are opaque names a task holds for its whole run; two
 * tasks naming the same lock never overlap. That is how checks that genuinely cannot share a
 * machine stay apart without the whole run going serial: every cargo leg takes cargo's exclusive
 * build-dir lock anyway (`cargo`), so running two of them at once would only burn a slot on
 * `Blocking waiting for file lock`.
 *
 * Scheduling is declaration order with skip-ahead: whenever a slot frees, the FIRST pending task
 * whose locks are all free starts. A lock-blocked task never holds back a later free one.
 */

export type PoolTask<T> = { locks: readonly string[]; run: () => Promise<T> };

/** Run every task, at most `limit` at once and never two sharing a lock. Results keep input order. */
export function runPool<T>(tasks: readonly PoolTask<T>[], limit: number): Promise<T[]> {
	if (!Number.isInteger(limit) || limit < 1) return Promise.reject(new Error(`pool limit must be ≥ 1, got ${limit}`));
	const results: T[] = new Array(tasks.length);
	const pending = tasks.map((_, index) => index);
	const held = new Set<string>();
	let running = 0;

	return new Promise<T[]>((resolve, reject) => {
		/** Start the first pending task whose locks are all free; false when none can start now. */
		const startNext = (): boolean => {
			const slot = pending.findIndex((index) => tasks[index]?.locks.every((lock) => !held.has(lock)));
			const index = slot === -1 ? undefined : pending.splice(slot, 1)[0];
			const task = index === undefined ? undefined : tasks[index];
			if (index === undefined || task === undefined) return false;
			for (const lock of task.locks) held.add(lock);
			running++;
			task.run().then((value) => {
				results[index] = value;
				for (const lock of task.locks) held.delete(lock);
				running--;
				pump();
			}, reject);
			return true;
		};
		const pump = () => {
			if (pending.length === 0 && running === 0) resolve(results);
			while (running < limit && startNext()) {}
		};
		pump();
	});
}
