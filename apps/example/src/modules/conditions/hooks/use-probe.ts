import { useCallback, useState } from "react";
import { type ProbeResult, probe } from "../utils/probe";

/** A small known HTTPS download (1 KB). */
export const PROBE_URL = "https://speed.cloudflare.com/__down?bytes=1000";

export type ProbeState = { phase: "idle" } | { phase: "loading" } | { phase: "done"; result: ProbeResult };

let keyCounter = 0;

/** Runs `probe` against `PROBE_URL`: 8 s timeout, one retry after 3 s, one idempotency key per press. */
export function useProbe(): { state: ProbeState; run: () => void } {
	const [state, setState] = useState<ProbeState>({ phase: "idle" });

	const run = useCallback(() => {
		setState({ phase: "loading" });
		probe(PROBE_URL, {
			fetchImpl: fetch,
			timeoutMs: 8000,
			retryDelayMs: 3000,
			newKey: () => `fetch-${Date.now()}-${++keyCounter}`,
			now: Date.now,
		}).then((result) => setState({ phase: "done", result }));
	}, []);

	return { state, run };
}
