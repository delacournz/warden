import { xctraceArgv } from "./xctrace-argv";

export type InstrumentCheck =
	| { ok: true; available: string[] }
	| { ok: false; missing: string[]; alternatives: Record<string, string[]>; available: string[] };

/** Instruments close in purpose to a missing one: same leading word, or the usual successor. */
const SIMILAR: Record<string, readonly string[]> = {
	Hangs: ["Hitches", "Animation Hitches", "Run Loops", "Thread Activity"],
	Leaks: ["Allocations", "VM Tracker"],
	Allocations: ["Leaks", "VM Tracker"],
};

type RunText = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

let cache: string[] | undefined;

export class InstrumentChecker {
	private alternativesFor(name: string, available: readonly string[]): string[] {
		const wanted = SIMILAR[name] ?? [];
		const lead = name.toLowerCase().slice(0, 4);
		const found = available.filter((a) => wanted.includes(a) || a.toLowerCase().includes(lead));
		return [...new Set(found)].filter((a) => a !== name).slice(0, 5);
	}

	/** Compare `wanted` against a `xctrace list instruments` listing. */
	checkInstruments(wanted: readonly string[], available: readonly string[]): InstrumentCheck {
		const have = new Set(available);
		const missing = wanted.filter((w) => !have.has(w));
		if (missing.length === 0) return { ok: true, available: [...available] };
		return {
			ok: false,
			missing,
			alternatives: Object.fromEntries(missing.map((m) => [m, this.alternativesFor(m, available)])),
			available: [...available],
		};
	}

	/** Forget the cached listing (tests). */
	reset(): void {
		cache = undefined;
	}

	/**
	 * Check `wanted` against `xctrace list instruments` on this host. The listing is fetched once per process and
	 * cached; a failing `xctrace` is reported as `undefined` (the caller decides: record and let xctrace complain).
	 * Exported for `warden perf doctor`.
	 */
	async checkXctraceInstruments(run: RunText, wanted: readonly string[]): Promise<InstrumentCheck | undefined> {
		if (cache === undefined) {
			const res = await run(xctraceArgv.listInstrumentsArgv());
			if (res.exitCode !== 0) return undefined;
			cache = xctraceArgv.parseInstruments(res.stdout);
		}
		return this.checkInstruments(wanted, cache);
	}
}

export const instrumentChecker = new InstrumentChecker();
