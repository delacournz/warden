#!/usr/bin/env bun
/**
 * Speed-target smoke for `warden ui` (manual / nightly, needs a real simulator or emulator).
 *
 *   bun scripts/smoke/ui-bench.ts [--udid <id>] [--platform ios|android] [--bundle <id>] [--runs <n>]
 *
 * Without `--udid` it claims a device, and releases exactly the lease id it claimed when done (never
 * `warden release --mine`: agents of one session share the session id and `--mine` would free their
 * devices). With `--udid` the device is yours already and is left alone. It opens the example app
 * (`nz.co.delacour.warden.example`, installed with `warden app ensure` from `apps/example`), runs
 * `warden ui bench --json`, prints the table and exits 1 when any metric is over target x1.5.
 * Runs this checkout's CLI source, not whatever `warden` is on PATH.
 */
import { join } from "node:path";
import { type BenchResult, renderBenchTable } from "../../apps/cli/src/agent-ui/bench";

const CLI = join(import.meta.dir, "../../apps/cli/src/cli.ts");
const DEFAULT_BUNDLE = "nz.co.delacour.warden.example";

type Args = { udid?: string; platform: "ios" | "android"; bundle: string; runs?: string };

/** Each flag stores its value in `args`; a string back is the complaint. */
const SETTERS: Record<string, (args: Args, value: string) => string | undefined> = {
	"--udid": (args, value) => {
		args.udid = value;
		return undefined;
	},
	"--bundle": (args, value) => {
		args.bundle = value;
		return undefined;
	},
	"--runs": (args, value) => {
		args.runs = value;
		return undefined;
	},
	"--platform": (args, value) => {
		if (value !== "ios" && value !== "android") return `--platform must be ios or android, got ${value}`;
		args.platform = value;
		return undefined;
	},
};

export function parseArgs(argv: readonly string[]): Args | string {
	const args: Args = { platform: "ios", bundle: DEFAULT_BUNDLE };
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i] ?? "";
		const set = SETTERS[flag];
		if (set === undefined) return `unknown argument ${flag}`;
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) return `${flag} needs a value`;
		const complaint = set(args, value);
		if (complaint !== undefined) return complaint;
	}
	return args;
}

type Ran = { code: number; stdout: string; stderr: string };

async function warden(...argv: string[]): Promise<Ran> {
	const proc = Bun.spawn([process.execPath, CLI, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

/** The lease id and device of the first lease of `warden claim --json` (`{leases: [{leaseId, udid, …}], udids, reclaimed}`). */
export function parseClaim(stdout: string): { leaseId: string; udid: string } | undefined {
	try {
		const raw: unknown = JSON.parse(stdout);
		const leases: unknown = typeof raw === "object" && raw !== null && "leases" in raw ? raw.leases : undefined;
		const first: unknown = Array.isArray(leases) ? leases[0] : undefined;
		if (typeof first === "object" && first !== null && "leaseId" in first && "udid" in first) {
			const { leaseId, udid } = first;
			if (typeof leaseId === "string" && typeof udid === "string") return { leaseId, udid };
		}
	} catch {
		// not JSON: reported by the caller
	}
	return undefined;
}

/** The `result.metrics` of a `warden ui bench --json` document, or the reason there are none. */
export function parseBench(stdout: string): { metrics: BenchResult } | { error: string } {
	try {
		const doc: unknown = JSON.parse(stdout);
		if (typeof doc === "object" && doc !== null && "ok" in doc) {
			if (doc.ok === false && "error" in doc) return { error: JSON.stringify(doc.error) };
			if ("result" in doc && typeof doc.result === "object" && doc.result !== null && "metrics" in doc.result) {
				return { metrics: doc.result.metrics as BenchResult };
			}
		}
	} catch {
		// falls through
	}
	return { error: `unparseable output: ${stdout.slice(0, 200)}` };
}

/** Names of the measured metrics over target x1.5 (`ok === false`). */
export function overTolerance(metrics: BenchResult): string[] {
	return Object.entries(metrics).flatMap(([name, metric]) =>
		metric !== undefined && !("skipped" in metric) && metric.ok === false ? [name] : []
	);
}

async function main(): Promise<number> {
	const args = parseArgs(Bun.argv.slice(2));
	if (typeof args === "string") {
		console.error(`ui-bench: ${args}`);
		return 1;
	}
	let leaseId: string | undefined;
	const release = async () => {
		if (leaseId === undefined) return;
		const id = leaseId;
		leaseId = undefined;
		const released = await warden("release", id);
		if (released.code !== 0) console.error(`ui-bench: releasing lease ${id} failed: ${released.stderr.trim()}`);
	};
	process.on("SIGINT", () => {
		void release().finally(() => process.exit(130));
	});
	try {
		let udid = args.udid;
		if (udid === undefined) {
			const claimed = await warden("claim", args.platform, "--json");
			const claim = claimed.code === 0 ? parseClaim(claimed.stdout) : undefined;
			if (claim === undefined) {
				console.error(`ui-bench: claim failed: ${(claimed.stderr || claimed.stdout).trim()}`);
				return 1;
			}
			({ leaseId, udid } = claim);
		}
		const opened = await warden("ui", "open", args.bundle, "--udid", udid, "--json");
		if (opened.code !== 0) {
			console.error(`ui-bench: opening ${args.bundle} failed: ${(opened.stdout || opened.stderr).trim()}`);
			return 1;
		}
		const benched = await warden("ui", "bench", "--json", "--udid", udid, ...(args.runs ? ["--runs", args.runs] : []));
		const bench = parseBench(benched.stdout);
		if ("error" in bench) {
			console.error(`ui-bench: bench failed: ${bench.error}`);
			return 1;
		}
		console.log(renderBenchTable(bench.metrics));
		const over = overTolerance(bench.metrics);
		if (over.length > 0) {
			console.error(`ui-bench: over target x1.5: ${over.join(", ")}`);
			return 1;
		}
		return 0;
	} finally {
		await release();
	}
}

if (import.meta.main) process.exit(await main());
