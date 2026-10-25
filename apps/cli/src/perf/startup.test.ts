import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { wardenHome } from "@delacour/warden-core/store";
import { type TestContext, testContext } from "../testing";
import { createSession, sessionDir } from "./session";
import { perfStartup, type StartupIo, type StartupMark, type StartupOptions } from "./startup";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = 5_000_000;
const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");

const droid = { platform: "android", id: "emulator-5554", name: "warden-pixel-1" } as const;
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

type Reply = Partial<ExecResult> | (() => Partial<ExecResult>);
type Rule = [needle: string, reply: Reply];

function setup(device: typeof droid | typeof sim, rules: Rule[], host: Parameters<typeof fakePerfDeps>[2] = {}) {
	const calls: string[] = [];
	const c = testContext([], {
		now: () => T0,
		exec: async (cmd) => {
			const line = cmd.join(" ");
			calls.push(line);
			const hit = rules.find(([needle]) => line.includes(needle));
			if (!hit) return { exitCode: 127, stdout: "", stderr: `no rule: ${line}` };
			const reply = typeof hit[1] === "function" ? hit[1]() : hit[1];
			return { exitCode: 0, stdout: "", stderr: "", ...reply };
		},
	});
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: device.platform, id: device.id, name: device.name }, T0);
	const sleeps: number[] = [];
	let t = 0;
	const io: StartupIo = {
		monotonicMs: () => (t += 150),
		mkdtemp: () => "/scratch",
		rm: () => undefined,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		readMarks: async () => ({ success: false, error: "no devtools target" }),
	};
	return { c, calls, io, sleeps, deps: fakePerfDeps([device], {}, host) };
}

type RunOpts = Partial<Omit<StartupOptions, "record">>;

/** `perf startup` as `agent me`: `--json --claim --app com.acme.shop` unless the call opts out. */
const run = (
	c: TestContext,
	deps: ReturnType<typeof fakePerfDeps>,
	io: StartupIo,
	opts: RunOpts = {},
	out: { text?: true; noClaim?: true } = {}
) =>
	perfStartup(
		c,
		deps,
		{
			app: "com.acme.shop",
			...(out.text === true ? {} : { json: true as const }),
			...(out.noClaim === true ? {} : { claim: true }),
			...opts,
		},
		io
	);

const json = (c: TestContext) => JSON.parse(c.stdout.join("\n"));

const amStart = (total: number, state = "COLD") =>
	`Status: ok\nLaunchState: ${state}\nActivity: com.acme.shop/.MainActivity\nTotalTime: ${total}\nWaitTime: ${total + 10}\nComplete\n`;

/** replies one after another, the last one repeating */
const seq = (...stdout: string[]): (() => Partial<ExecResult>) => {
	let i = 0;
	return () => ({ stdout: stdout[Math.min(i++, stdout.length - 1)] as string });
};

const androidRules = (start: Reply): Rule[] => [
	["resolve-activity", { stdout: fx("resolve-activity.txt") }],
	["logcat -c", {}],
	["logcat -d", { stdout: "" }],
	["pidof", { stdout: "321\n" }],
	["KEYCODE_HOME", {}],
	["am start", start],
];

function startupFiles(c: TestContext): string[] {
	const root = join(wardenHome(c.env), "perf");
	return readdirSync(root).map((id) => join(root, id, "metrics", "startup.json"));
}

describe("perf startup: android", () => {
	test("cold x3: am start -W -S each run; median/p90 of TotalTime; startup.json written", async () => {
		const { c, calls, io, deps } = setup(droid, androidRules(seq(amStart(1800), amStart(2000), amStart(1900))));
		expect(await run(c, deps, io, { runs: "3" })).toBe(0);
		const doc = json(c);
		expect(doc).toMatchObject({
			ok: true,
			command: "perf startup",
			result: {
				method: "am-start",
				appId: "com.acme.shop",
				summary: { cold: { runs: 3, medianMs: 1900, p90Ms: 2000, minMs: 1800, maxMs: 2000 } },
			},
		});
		expect(doc.result.runs.map((r: { totalMs: number }) => r.totalMs)).toEqual([1800, 2000, 1900]);
		expect(calls.filter((l) => l.includes("am start -W -S -n com.acme.shop/.MainActivity"))).toHaveLength(3);
		const [file] = startupFiles(c);
		expect(JSON.parse(readFileSync(file as string, "utf8")).summary.cold.medianMs).toBe(1900);
		expect(doc.result.path).toBe(file);
	});

	test("default is 5 cold runs", async () => {
		const { c, calls, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }));
		await run(c, deps, io);
		expect(calls.filter((l) => l.includes("am start"))).toHaveLength(5);
	});

	test("warm: HOME then am start without -S, settle in between; app already running", async () => {
		const { c, calls, io, sleeps, deps } = setup(droid, androidRules({ stdout: amStart(300, "HOT") }));
		expect(await run(c, deps, io, { warm: true, runs: "2" })).toBe(0);
		const starts = calls.filter((l) => l.includes("am start"));
		expect(starts).toHaveLength(2);
		expect(starts.every((l) => !l.includes("-S"))).toBe(true);
		expect(calls.filter((l) => l.includes("KEYCODE_HOME"))).toHaveLength(2);
		expect(sleeps).toEqual([1000, 1000]);
		expect(json(c).result.summary.warm.medianMs).toBe(300);
		expect(json(c).result.summary.cold).toBeUndefined();
	});

	test("warm with the app not running starts it first (untimed)", async () => {
		const { c, calls, io, deps } = setup(droid, [
			["pidof", { exitCode: 1 }],
			...androidRules({ stdout: amStart(300, "HOT") }),
		]);
		await run(c, deps, io, { warm: true, runs: "1" });
		expect(calls.filter((l) => l.includes("am start"))).toHaveLength(2);
		expect(json(c).result.runs).toHaveLength(1);
	});

	test("--cold --warm runs both and a warm run that lost its process is noted", async () => {
		const { c, io, deps } = setup(droid, androidRules(seq(amStart(1500), amStart(600, "COLD"))));
		await run(c, deps, io, { cold: true, warm: true, runs: "1" });
		const doc = json(c);
		expect(Object.keys(doc.result.summary)).toEqual(["cold", "warm"]);
		expect(doc.result.notes.some((n: string) => n.includes("warm run 1 was a cold start"))).toBe(true);
	});

	test("reportFullyDrawn: picks up the new line each run", async () => {
		const drawn = (ms: string) =>
			`10-24 12:00:03.011  1503  1530 I ActivityTaskManager: Fully drawn com.acme.shop/.MainActivity: +${ms}\n`;
		const { c, io, deps } = setup(droid, [
			["logcat -d", seq(drawn("3s641ms"), drawn("3s641ms") + drawn("2s100ms"))],
			...androidRules({ stdout: amStart(1800) }),
		]);
		await run(c, deps, io, { runs: "2" });
		expect(json(c).result.runs.map((r: { fullyDrawnMs?: number }) => r.fullyDrawnMs)).toEqual([3641, 2100]);
	});

	test("slow cold start: warn finding, and the text report carries the simulator banner", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(2600) }));
		await run(c, deps, io, { runs: "3" }, { text: true });
		const out = c.stdout.join("\n");
		expect(out).toContain("simulator: compare relative");
		expect(out).toContain("[warn] startup");
		expect(out).toContain("cold  median 2600ms");
		expect(out).toContain("next:");
	});

	test("> 5s is critical", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(5600) }));
		await run(c, deps, io, { runs: "1" });
		expect(json(c).result.findings[0]).toMatchObject({ kind: "startup", severity: "critical", method: "am-start" });
	});

	test("a start that fails stops the run with the system's message", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: fx("am-start-error.txt") }));
		expect(await run(c, deps, io)).toBe(1);
		expect(json(c)).toMatchObject({ ok: false, error: { code: "failed" } });
	});

	test("writes into the active session when there is one", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }));
		const made = createSession(c, deps.session, {
			device: { udid: droid.id, platform: "android", name: droid.name },
			target: { udid: droid.id, ownedByCaller: true },
			maxDurationMs: 60_000,
		});
		if (!made.success) throw new Error("create");
		await run(c, deps, io, { runs: "1" });
		expect(json(c).result.path).toBe(join(sessionDir(c, made.data.id), "metrics", "startup.json"));
	});
});

describe("perf startup: usage and safety", () => {
	test("--runs bounds", async () => {
		for (const runs of ["0", "21", "abc"]) {
			const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }));
			expect(await run(c, deps, io, { runs })).toBe(1);
			expect(json(c)).toMatchObject({ ok: false, error: { code: "usage" } });
		}
	});

	test("--method is iOS only on Android", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }));
		expect(await run(c, deps, io, { method: "xctrace" })).toBe(1);
		expect(json(c).error.code).toBe("usage");
	});

	test("no lease and no --claim: refused, the app is never touched", async () => {
		const { c, calls, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }));
		expect(await run(c, deps, io, {}, { noClaim: true })).toBe(2);
		expect(calls.some((l) => l.includes("am start") || l.includes("force-stop"))).toBe(false);
	});
});

describe("perf startup: RN marks", () => {
	const marks: StartupMark[] = [
		{ name: "nativeLaunchStart", startTimeMs: 12 },
		{ name: "runJSBundleEnd", startTimeMs: 840 },
	];

	test("marks from Metro are included and listed", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }), {
			metro: async () => "http://127.0.0.1:8081",
		});
		let asked: unknown[] = [];
		io.readMarks = async (...args) => {
			asked = args;
			return { success: true, data: marks };
		};
		await run(c, deps, io, { runs: "1" });
		expect(json(c).result.marks).toEqual(marks);
		expect(asked).toEqual(["http://127.0.0.1:8081", "com.acme.shop", droid.name]);
		await run(c, deps, io, { runs: "1" }, { text: true });
		expect(c.stdout.join("\n")).toContain("runJSBundleEnd  +840ms");
	});

	test("no Metro: skipped with a note, not an error", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }));
		expect(await run(c, deps, io, { runs: "1" })).toBe(0);
		expect(json(c).result.marks).toEqual([]);
		expect(json(c).result.notes).toContain("no Metro for this device: RN marks skipped");
	});

	test("Metro up but no target: skipped with the reason", async () => {
		const { c, io, deps } = setup(droid, androidRules({ stdout: amStart(1000) }), {
			metro: async () => "http://127.0.0.1:8081",
		});
		expect(await run(c, deps, io, { runs: "1" })).toBe(0);
		expect(json(c).result.notes).toContain("RN marks skipped: no devtools target");
	});
});

describe("perf startup: ios", () => {
	const iosRules = (extra: Rule[] = []): Rule[] => [
		...extra,
		["simctl get_app_container", { stdout: "/Dev/U1/Bundle/Shop.app\n" }],
		["plutil", { stdout: "Shop\n" }],
		["simctl terminate", {}],
		["simctl spawn U1 launchctl list", { stdout: fx("launchctl-list.txt") }],
		["simctl launch", { stdout: "com.acme.shop: 4242\n" }],
	];

	test("default approx: wall time of simctl launch --terminate-running-process", async () => {
		const { c, calls, io, deps } = setup(sim, iosRules());
		expect(await run(c, deps, io, { runs: "2" })).toBe(0);
		const doc = json(c);
		expect(doc.result.method).toBe("simctl-approx");
		expect(doc.result.summary.cold).toMatchObject({ runs: 2, medianMs: 150 });
		expect(
			calls.filter((l) => l.startsWith("xcrun simctl launch --terminate-running-process U1 com.acme.shop"))
		).toHaveLength(2);
		expect(doc.result.notes[0]).toContain("lower bound");
	});

	test("slow approx start maps to the approx finding method", async () => {
		const { c, deps, io } = setup(sim, iosRules());
		let t = 0;
		io.monotonicMs = () => (t += 3000);
		await run(c, deps, io, { runs: "1" });
		expect(json(c).result.findings[0]).toMatchObject({ kind: "startup", method: "approx", severity: "warn" });
	});

	test("unknown --method", async () => {
		const { c, io, deps } = setup(sim, iosRules());
		expect(await run(c, deps, io, { method: "magic" })).toBe(1);
		expect(json(c).error.code).toBe("usage");
	});

	test("xctrace (spike): records, exports the launch table, parses Total App Launch", async () => {
		const { c, calls, io, deps } = setup(sim, [
			["xcrun xctrace record", {}],
			["--toc", { stdout: fx("xctrace-toc-app-launch.xml") }],
			["--xpath", { stdout: fx("xctrace-export-life-cycle-period.xml") }],
			...iosRules(),
		]);
		expect(await run(c, deps, io, { method: "xctrace", runs: "2" })).toBe(0);
		const doc = json(c);
		expect(doc.result).toMatchObject({ method: "xctrace", summary: { cold: { runs: 2, medianMs: 1620 } } });
		const record = calls.find((l) => l.startsWith("xcrun xctrace record")) as string;
		expect(record).toContain("--template App Launch");
		expect(record).toContain("--launch -- /Dev/U1/Bundle/Shop.app");
		expect(calls.filter((l) => l.includes("simctl terminate"))).toHaveLength(2);
	});

	test("xctrace: warm is refused", async () => {
		const { c, io, deps } = setup(sim, iosRules());
		expect(await run(c, deps, io, { method: "xctrace", warm: true })).toBe(1);
		expect(json(c).error.code).toBe("usage");
	});

	test("xctrace: a trace with no launch table fails with the approx hint", async () => {
		const { c, io, deps } = setup(sim, [
			["xcrun xctrace record", {}],
			["--toc", { stdout: "<trace-toc/>" }],
			...iosRules(),
		]);
		expect(await run(c, deps, io, { method: "xctrace", runs: "1" })).toBe(1);
		expect(json(c).error.hint).toContain("--method approx");
	});

	test("warm approx: springboard in between, app started first when not running", async () => {
		const { c, calls, io, deps } = setup(sim, iosRules());
		expect(await run(c, deps, io, { warm: true, runs: "1" })).toBe(0);
		expect(calls).toContain("xcrun simctl launch U1 com.apple.springboard");
		expect(calls.some((l) => l === "xcrun simctl launch U1 com.acme.shop")).toBe(true);
	});
});
