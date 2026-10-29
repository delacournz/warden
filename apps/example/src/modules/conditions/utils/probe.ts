export type ProbeResult = {
	ok: boolean;
	status: number | null;
	durationMs: number;
	attempts: number;
	error: string | null;
	/** The idempotency key sent on every attempt of this probe. */
	key: string;
};

export type ProbeDeps = {
	fetchImpl: typeof fetch;
	timeoutMs: number;
	retryDelayMs: number;
	newKey: () => string;
	now: () => number;
};

const MAX_ATTEMPTS = 2;

type Attempt = { status: number | null; error: string | null };

async function attempt(url: string, key: string, deps: ProbeDeps): Promise<Attempt> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
	try {
		const response = await deps.fetchImpl(url, { headers: { "Idempotency-Key": key }, signal: controller.signal });
		await response.arrayBuffer();
		return { status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
	} catch (cause) {
		const aborted = controller.signal.aborted;
		return { status: null, error: aborted ? "Timed out" : cause instanceof Error ? cause.message : String(cause) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fetches `url` with a timeout and one retry. Every attempt carries the same `Idempotency-Key`, so a server that saw
 * the first request (it timed out on the client) can answer the retry from the first result instead of repeating it.
 */
export async function probe(url: string, deps: ProbeDeps): Promise<ProbeResult> {
	const key = deps.newKey();
	const startedAt = deps.now();
	let last: Attempt = { status: null, error: null };
	let attempts = 0;
	while (attempts < MAX_ATTEMPTS) {
		attempts += 1;
		last = await attempt(url, key, deps);
		if (last.error === null) break;
		if (attempts < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs));
	}
	return {
		ok: last.error === null,
		status: last.status,
		durationMs: deps.now() - startedAt,
		attempts,
		error: last.error,
		key,
	};
}
