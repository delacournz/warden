import { useCallback, useEffect, useState } from "react";

/**
 * The device wall clock, re-read every second so a clock change shows up without a relaunch, and on demand through
 * `refresh`. The timer is only a convenience: a timer armed while the clock was ahead waits for the shifted time
 * once the clock goes back, so `refresh` is the way to re-read then.
 */
export function useNow(intervalMs = 1000): { now: number; refresh: () => void } {
	const [now, setNow] = useState(() => Date.now());
	const refresh = useCallback(() => setNow(Date.now()), []);
	useEffect(() => {
		const timer = setInterval(refresh, intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, refresh]);
	return { now, refresh };
}
