/**
 * The idle-sim control (WDN-CPU 0.3): what a booted simulator with the app on its first screen costs with no
 * framework attached, so a framework's `sim` column can be read net of the app's own work. `scripts/idle-sim.ts`
 * samples with `startSampler` for `seconds`; this module holds the argument parsing and the summary text.
 */
import { err, ok, type Result } from "@delacour/warden-types/result";
import { bytes } from "../report/format";
import type { Series } from "../results/schema";

export type IdleArgs = {
	udid: string;
	seconds: number;
	/** extra host roots to track (a resident `warden-simd`, a `warden ui` session): their tree is the `host` series */
	pids: number[];
	out: string | undefined;
	/** bundle id to `simctl launch` before sampling */
	launch: string | undefined;
};

type Setter = (out: IdleArgs, value: string) => string | undefined;

/** One setter per flag: returns an error message for a bad value. */
const FLAGS: Readonly<Record<string, Setter>> = {
	"--udid": (out, value) => {
		out.udid = value;
		return undefined;
	},
	"--seconds": (out, value) => {
		const n = Number(value);
		if (!Number.isFinite(n) || n <= 0) return `--seconds must be a positive number, got ${value}`;
		out.seconds = n;
		return undefined;
	},
	"--pids": (out, value) => {
		const pids = value.split(",").map((p) => Number(p.trim()));
		if (pids.some((p) => !Number.isInteger(p) || p <= 0)) return `--pids must be a comma list of pids, got ${value}`;
		out.pids = pids;
		return undefined;
	},
	"--out": (out, value) => {
		out.out = value;
		return undefined;
	},
	"--launch": (out, value) => {
		out.launch = value;
		return undefined;
	},
};

export function parseIdleArgs(argv: readonly string[]): Result<IdleArgs> {
	const out: IdleArgs = { udid: "", seconds: 60, pids: [], out: undefined, launch: undefined };
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i] ?? "";
		const value = argv[i + 1];
		const set = FLAGS[flag];
		if (set === undefined || value === undefined) return err(`unknown or incomplete flag: ${flag}`);
		const problem = set(out, value);
		if (problem !== undefined) return err(problem);
	}
	if (out.udid === "") return err("--udid <sim udid> is required");
	return ok(out);
}

function line(scope: "sim" | "host", s: Series, seconds: number): string {
	const head =
		s.cpuSeconds === undefined
			? `${scope}: no CPU-seconds (ps had no time column)`
			: `${scope}: ${s.cpuSeconds.toFixed(2)} CPU-s over ${seconds} s (${((100 * s.cpuSeconds) / seconds).toFixed(1)}% of one core)`;
	return `${head}; %cpu avg ${s.cpuAvgPct.toFixed(1)} / peak ${s.cpuPeakPct.toFixed(1)}; RSS avg ${bytes(s.rssAvgBytes)} / peak ${bytes(s.rssPeakBytes)}; ${s.samples} samples`;
}

export function idleSummary(input: { sim: Series; host: Series; seconds: number }): string {
	return [line("sim", input.sim, input.seconds), line("host", input.host, input.seconds)].join("\n");
}
