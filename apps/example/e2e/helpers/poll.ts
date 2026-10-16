const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 250;

/** Calls `read` until `accept` likes its value, then returns it; the last value when `timeoutMs` passes. */
export async function pollUntil<T>(
	read: () => Promise<T>,
	accept: (value: T) => boolean,
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		value = await read();
	}
	return value;
}
