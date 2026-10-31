/** A single request's outcome. `ms` is wall time from send to the last byte, or to the failure. */
export type PingResult =
	| { ok: true; status: number; ms: number }
	| { ok: false; status: number | null; error: string; ms: number };

export type PingDeps = {
	fetchImpl: typeof fetch;
	timeoutMs: number;
	now: () => number;
};

/**
 * One GET with a timeout and no retry: a demo has to show a failure as a failure, so nothing here hides one. An
 * error status counts as a failure (`error` is `HTTP <status>`), an abort at the timeout is `Timed out`.
 */
export async function ping(url: string, deps: PingDeps): Promise<PingResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
	const startedAt = deps.now();
	try {
		const response = await deps.fetchImpl(url, { signal: controller.signal });
		await response.arrayBuffer();
		const ms = deps.now() - startedAt;
		if (response.ok) return { ok: true, status: response.status, ms };
		return { ok: false, status: response.status, error: `HTTP ${response.status}`, ms };
	} catch (cause) {
		const error = controller.signal.aborted ? "Timed out" : cause instanceof Error ? cause.message : String(cause);
		return { ok: false, status: null, error, ms: deps.now() - startedAt };
	} finally {
		clearTimeout(timer);
	}
}
