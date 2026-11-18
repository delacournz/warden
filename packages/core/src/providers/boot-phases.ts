/** One stretch of a simulator boot, named after `simctl bootstatus`'s `Waiting on <name>` line (lower-cased). */
export type BootPhase = { name: string; ms: number };

/** Follows a boot's `simctl bootstatus` progress lines and says how long each phase took. */
export type BootPhaseClock = {
	/** one line of bootstatus output; only `Waiting on <phase>` lines move the clock to a new phase */
	line: (text: string) => void;
	/** `<total> s (<phase> <s>, …)` up to now: phases that took no time are left out */
	summary: () => string;
};

const WAITING_ON = /^Waiting on (.+)$/;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * The time before the first `Waiting on` line is `booting`; each `Waiting on X` runs until the next different one,
 * and the last until `summary` is asked. bootstatus repeats the current phase on every status tick, so a repeat is
 * the same phase. A first boot spends most of its time in `data migration`, which a clone of a booted sim skips.
 */
export function bootPhaseClock(now: () => number): BootPhaseClock {
	const start = now();
	const done: BootPhase[] = [];
	let current = { name: "booting", since: start };
	return {
		line: (text) => {
			const match = WAITING_ON.exec(text.trim());
			const name = match?.[1]?.toLowerCase();
			if (name === undefined || name === current.name) return;
			const at = now();
			done.push({ name: current.name, ms: at - current.since });
			current = { name, since: at };
		},
		summary: () => {
			const at = now();
			const phases = [...done, { name: current.name, ms: at - current.since }].filter((p) => p.ms > 0);
			return `${seconds(at - start)} (${phases.map((p) => `${p.name} ${seconds(p.ms)}`).join(", ")})`;
		},
	};
}
