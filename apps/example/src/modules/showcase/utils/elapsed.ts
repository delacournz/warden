/** `mm:ss.cc` for an event log line, `ms` since the screen opened. */
export function formatElapsed(ms: number): string {
	const t = Math.max(0, ms);
	const m = Math.floor(t / 60_000);
	const s = (t % 60_000) / 1000;
	return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
