/**
 * `fn` over `items` with at most `limit` calls running at once; results come back in item order.
 * The first rejection rejects the whole call and no further item is started.
 */
export async function mapBounded<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const lane = async (): Promise<void> => {
		while (!failed) {
			const index = next++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index] as T, index);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
	return results;
}
