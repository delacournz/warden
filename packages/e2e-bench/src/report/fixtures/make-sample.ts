import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../../results/manifest";
import {
	type BenchRun,
	CANONICAL_IDS,
	type CanonicalId,
	type FrameworkResult,
	type OkFrameworkResult,
	type RepResult,
	type StepResult,
	type TestResult,
} from "../../results/schema";
import { frameworkStats, withRatios } from "../../results/stats";

/** Deterministic PRNG so the committed sample never changes between runs. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Warden per-test baseline durations (ms), each within 4–20 s. */
const BASE_MS: Record<CanonicalId, number> = {
	"onboarding/steps-to-sign-in": 6200,
	"sign-in/field-errors": 5100,
	"sign-in/locked-account": 4300,
	"sign-in/valid-credentials": 7000,
	"todos/add-complete-filter": 8400,
	"todo-detail/open-toggle-delete": 9300,
	"todo-detail/deep-link": 6100,
	"settings/account-switches-sign-out": 5200,
};

type Profile = {
	/** fixed per framework so dropping one never reshuffles the others' numbers */
	seed: number;
	framework: "warden" | "argent" | "agent-device";
	version: string;
	testScale: number;
	overheadMs: number;
	prepareMs: number;
	teardownMs: number;
	withSteps: boolean;
	/** share of each test's wall time its trace leaves unexplained; only warden reports one */
	untracedShare?: number;
};

const PROFILES: readonly Profile[] = [
	{
		seed: 1000,
		framework: "warden",
		version: "0.19.0",
		testScale: 1,
		overheadMs: 9800,
		prepareMs: 2300,
		teardownMs: 600,
		withSteps: true,
		untracedShare: 0.2,
	},
	{
		seed: 1002,
		framework: "argent",
		version: "0.11.2",
		testScale: 1.8,
		overheadMs: 20400,
		prepareMs: 4100,
		teardownMs: 900,
		withSteps: false,
	},
	{
		seed: 1003,
		framework: "agent-device",
		version: "0.7.4",
		testScale: 2.1,
		overheadMs: 25200,
		prepareMs: 5600,
		teardownMs: 1200,
		withSteps: false,
	},
];

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Splits a test's duration across its manifest step labels with seeded weights. */
function stepsFor(label: readonly string[], durationMs: number, rand: () => number): StepResult[] {
	const weights = label.map(() => 0.5 + rand());
	const total = weights.reduce((a, b) => a + b, 0);
	return label.map((text, i) => ({
		kind: text.split(" ")[0] ?? "step",
		label: text,
		ms: round1(((weights[i] ?? 1) / total) * durationMs),
		status: "passed",
	}));
}

function buildRep(
	profile: Profile,
	index: number,
	rand: () => number,
	stepLabels: Record<CanonicalId, string[]>
): RepResult {
	const cold = index === 1;
	const coldFactor = cold ? 1.3 : 1;
	const tests: TestResult[] = CANONICAL_IDS.map((id) => {
		const jitter = 0.97 + rand() * 0.06;
		const durationMs = round1(BASE_MS[id] * profile.testScale * jitter * coldFactor);
		return {
			id,
			nativeName: id,
			status: "passed",
			durationMs,
			...(profile.withSteps ? { steps: stepsFor(stepLabels[id], durationMs, rand) } : {}),
			...(profile.untracedShare === undefined ? {} : { untracedMs: round1(durationMs * profile.untracedShare) }),
		};
	});
	const sum = tests.reduce((acc, t) => acc + (t.durationMs ?? 0), 0);
	const wallMs = round1(sum + profile.overheadMs * coldFactor * (0.98 + rand() * 0.04));
	const startedAt = new Date(Date.UTC(2026, 9, 16, 1, 0, 0) + index * 200_000).toISOString();
	return {
		index,
		cold,
		wallMs,
		wallSource: "harness",
		startedAt,
		tests,
		rawArtifactDir: `artifacts/${profile.framework}/rep-${index}`,
	};
}

type OkBase = Omit<OkFrameworkResult, "stats">;

function okBase(profile: Profile, seed: number, stepLabels: Record<CanonicalId, string[]>): OkBase {
	const rand = mulberry32(seed);
	const reps = [1, 2, 3].map((i) => buildRep(profile, i, rand, stepLabels));
	const heavy = profile.framework === "agent-device";
	return {
		framework: profile.framework,
		status: "ok",
		version: profile.version,
		phases: { prepareMs: profile.prepareMs, teardownMs: profile.teardownMs },
		reps,
		resources: {
			host: {
				cpuAvgPct: heavy ? 38.2 : 21.4,
				cpuPeakPct: heavy ? 212.5 : 96.3,
				rssAvgBytes: (heavy ? 640 : 210) * 1024 * 1024,
				rssPeakBytes: (heavy ? 910 : 260) * 1024 * 1024,
				samples: Math.round(reps.reduce((a, r) => a + r.wallMs, 0) / 500),
			},
			sim: {
				cpuAvgPct: 31.7,
				cpuPeakPct: 140.2,
				rssAvgBytes: 1450 * 1024 * 1024,
				rssPeakBytes: 1620 * 1024 * 1024,
				samples: Math.round(reps.reduce((a, r) => a + r.wallMs, 0) / 500),
			},
		},
		residue: residueFor(profile.framework),
		footprint: footprintFor(profile.framework),
	};
}

function residueFor(framework: Profile["framework"]): OkBase["residue"] {
	if (framework === "agent-device") {
		return {
			processes: ["agent-device daemon"],
			driverApps: ["com.callstack.agentdevice.runner.xctrunner"],
			paths: [{ path: "~/.agent-device", deltaBytes: 4_194_304 }],
		};
	}
	return { processes: [], driverApps: [], paths: [] };
}

function footprintFor(framework: Profile["framework"]): OkBase["footprint"] {
	const table: Record<Profile["framework"], OkBase["footprint"]> = {
		warden: {
			testSourceLoc: 412,
			testSourceBytes: 15_300,
			depsBytes: 0,
			binaryBytes: 58_720_256,
			notes: ["bundled spec API"],
		},
		argent: { testSourceLoc: 298, testSourceBytes: 8_900, depsBytes: 0, binaryBytes: 96_468_992, notes: [] },
		"agent-device": {
			testSourceLoc: 354,
			testSourceBytes: 11_200,
			depsBytes: 31_457_280,
			binaryBytes: 12_582_912,
			notes: ["script runner via bun"],
		},
	};
	return table[framework];
}

/** Builds the full sample `BenchRun` (6 frameworks) the report tests and goldens use. */
export function buildSampleRun(): BenchRun {
	const manifest = loadManifest(join(dirname(fileURLToPath(import.meta.url)), "../../.."));
	const stepLabels = Object.fromEntries(CANONICAL_IDS.map((id) => [id, manifest.tests[id]?.steps ?? []])) as Record<
		CanonicalId,
		string[]
	>;
	const withStats = PROFILES.map((profile) => {
		const base = okBase(profile, profile.seed, stepLabels);
		return {
			...base,
			stats: frameworkStats({ reps: base.reps, prepareMs: base.phases.prepareMs, teardownMs: base.phases.teardownMs }),
		};
	});
	const ok: OkFrameworkResult[] = withRatios(withStats);
	const testerArmy: FrameworkResult = {
		framework: "tester-army",
		status: "failed",
		version: "0.20.0",
		phase: "run",
		error: "parity breach: unmapped tests: sign-in › accepts any email (not in manifest)",
	};
	return {
		schemaVersion: 1,
		id: "bench-2026-10-16-ios-a1b2c3",
		startedAt: "2026-10-16T01:00:00.000Z",
		endedAt: "2026-10-16T01:42:30.000Z",
		host: {
			model: "MacBook Pro (16-inch, 2023)",
			cpu: "Apple M3 Max",
			cores: 14,
			memBytes: 38_654_705_664,
			macos: "26.0 (25A354)",
			xcode: "26.0.1",
			java: "21.0.5",
			node: "24.19.0",
			bun: "1.3.14",
			warden: "0.19.0",
			loadAvgAtStart: 1.42,
		},
		device: {
			platform: "ios",
			udid: "9F3C2E7A-5B1D-4C88-A0E4-7D2B6C1F8E55",
			name: "iPhone 17 Pro",
			runtime: "iOS 26.0",
			leaseId: "lease-7f3a",
		},
		app: {
			bundleId: "nz.co.delacour.warden.example",
			appPath: "~/.warden/builds/ios/3fa91c07b2de/Example.app",
			hash: "3fa91c07b2de",
			sha256: "9b4e1c7a52d08f36a1e47cb0d95f2a68c3071be4d8a9f5026c1d3e7b8a40f512",
			bytes: 61_865_984,
		},
		options: {
			runs: 3,
			retries: 0,
			rebootBetween: false,
			frameworks: ["warden", "argent", "agent-device", "tester-army"],
			caffeinated: true,
		},
		frameworks: [...ok, testerArmy],
	};
}

/**
 * `run` with per-rep resources on every ok framework (`cpuSecondsOf(framework, repIndex)` host CPU-seconds,
 * a fixed window) and a whole-framework host split by group. The committed sample has none, so the report
 * goldens stay the pre-CPU-seconds format; tests of the new columns use this.
 */
export function withRepCpu(run: BenchRun, cpuSecondsOf: (framework: string, rep: number) => number): BenchRun {
	const out = structuredClone(run);
	for (const f of out.frameworks) {
		if (f.status !== "ok") continue;
		let total = 0;
		for (const rep of f.reps) {
			const cpuSeconds = cpuSecondsOf(f.framework, rep.index);
			total += cpuSeconds;
			const host = { ...f.resources.host, cpuSeconds, cpuRatePct: (cpuSeconds / (rep.wallMs / 1000)) * 100 };
			rep.resources = {
				window: { startMs: rep.index * 100_000, endMs: rep.index * 100_000 + rep.wallMs },
				host,
				sim: f.resources.sim,
				cpuSeconds,
				rssPeakBytes: host.rssPeakBytes,
			};
		}
		f.resources.host = {
			...f.resources.host,
			cpuSeconds: total + 2,
			cpuRatePct: 9.5,
			byGroup: {
				"bun-test": { cpuSeconds: total, rssAvgBytes: 100 * 1024 ** 2, rssPeakBytes: 120 * 1024 ** 2 },
				"warden-simd": { cpuSeconds: 2, rssAvgBytes: 30 * 1024 ** 2, rssPeakBytes: 31 * 1024 ** 2 },
			},
		};
	}
	return out;
}

if (import.meta.main) {
	const out = join(dirname(fileURLToPath(import.meta.url)), "bench-results.sample.json");
	writeFileSync(out, `${JSON.stringify(buildSampleRun(), null, "\t")}\n`);
	console.log(`wrote ${out}`);
}
