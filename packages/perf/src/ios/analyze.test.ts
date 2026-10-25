import { describe, expect, test } from "bun:test";
import {
	buildReport,
	classifyFrame,
	createAccumulator,
	dominantFrame,
	hangSeverity,
	leakSeverity,
	type NativeSample,
	normaliseThread,
	reportFindings,
	reportSection,
} from "./analyze";
import { analyzeTrace, type TraceDeps } from "./trace";

const APP = "/D/Containers/Bundle/Application/X/ShopApp.app/ShopApp";
const SYS =
	"/Library/Developer/CoreSimulator/Volumes/v/Profiles/Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot/System/Library/UIKitCore";

describe("classifyFrame", () => {
	test("app code under CoreSimulator is app, the simulator runtime root is system", () => {
		expect(classifyFrame({ name: "f", binary: APP })).toBe("app");
		expect(classifyFrame({ name: "f", binary: SYS })).toBe("system");
		expect(classifyFrame({ name: "f", binary: "/usr/lib/system/libdispatch.dylib" })).toBe("system");
		expect(classifyFrame({ name: "f", binary: "/System/Library/Frameworks/Foundation" })).toBe("system");
	});
	test("react native runtime", () => {
		expect(classifyFrame({ name: "-[RCTView layoutSubviews]", binary: APP })).toBe("rn");
		expect(classifyFrame({ name: "YGNodeCalculateLayout", binary: APP })).toBe("rn");
		expect(classifyFrame({ name: "facebook::jsi::Value::Value", binary: APP })).toBe("rn");
		expect(classifyFrame({ name: "x", binary: `${APP}.app/Frameworks/hermes.framework/hermes` })).toBe("rn");
	});
	test("app frame beats rn frame beats nothing", () => {
		const rn = { name: "RCTFoo", binary: APP };
		const app = { name: "myWork", binary: "/Frameworks/Third.framework/Third" };
		const sys = { name: "objc_msgSend", binary: "/usr/lib/libobjc.A.dylib" };
		expect(dominantFrame([sys, rn, app])?.frame.name).toBe("myWork");
		expect(dominantFrame([sys, rn])?.cls).toBe("rn");
		expect(dominantFrame([sys])).toBeUndefined();
	});
});

describe("normaliseThread", () => {
	test.each([
		["Main Thread 0x1a01 (ShopApp, pid: 42)", "Main Thread"],
		["com.facebook.react.JavaScript 0x1b (ShopApp, pid: 42)", "JS Thread"],
		["hermes 0x1 (A, pid: 1)", "JS Thread"],
		["com.facebook.react.ShadowQueue 0x2 (A, pid: 1)", "Shadow Thread"],
		["Thread 0x2c03 (A, pid: 1)", "Thread"],
		["com.apple.network.connections 0x9 (A, pid: 1)", "com.apple.network.connections"],
		["Main Thread (0x6655fe) (WindowServer, pid: 56295)", "Main Thread"],
		["Preferences (0x1bb1cea) (Preferences, pid: 15431)", "Main Thread"],
		["com.apple.uikit.eventfetch-thread (0x1bb2001) (Preferences, pid: 15431)", "com.apple.uikit.eventfetch-thread"],
		["Thread (0x2c03) (A, pid: 1)", "Thread"],
	])("%s", (raw, want) => expect(normaliseThread(raw)).toBe(want));
});

describe("thresholds", () => {
	const sample = (frame: string, i: number): NativeSample => ({
		timeNs: i,
		thread: "Main Thread 0x1 (A, pid: 1)",
		weightNs: 1_000_000,
		frames: [{ name: frame, binary: APP }],
	});
	test("over 15% red, 3-15% yellow, under 3% dropped", () => {
		const acc = createAccumulator();
		let i = 0;
		for (const [name, n] of [
			["red", 20],
			["yellow", 5],
			["tiny", 2],
			["filler", 73],
		] as const)
			for (let k = 0; k < n; k++) acc.add(sample(name, i++));
		const r = buildReport({ stats: acc.stats(), hangs: [], leaks: [] });
		expect(r.hotspots.map((h) => [h.frame, h.severity])).toEqual([
			["filler", "critical"],
			["red", "critical"],
			["yellow", "warn"],
		]);
		const findings = reportFindings(r, "t.trace");
		expect(findings.every((f) => f.kind === "native-hotspot")).toBe(true);
		expect(reportSection(r).lines.join("\n")).toContain("yellow");
	});
	test("hang and leak severities", () => {
		expect([hangSeverity(600), hangSeverity(300), hangSeverity(100)]).toEqual(["critical", "warn", "info"]);
		expect([leakSeverity(2_000_000), leakSeverity(100_000), leakSeverity(10)]).toEqual(["critical", "warn", "info"]);
	});
});

describe("large exports", () => {
	const HEAD = `<?xml version="1.0"?><trace-query-result><node><schema name="time-profile"><col><mnemonic>time</mnemonic></col><col><mnemonic>thread</mnemonic></col><col><mnemonic>weight</mnemonic></col><col><mnemonic>stack</mnemonic></col></schema>\n`;
	const FRAMES = Array.from(
		{ length: 24 },
		(_, i) =>
			`<frame id="${100 + i}" name="fn${i}" addr="0x${i}"><binary id="${200 + i}" name="b" path="${i < 12 ? APP : "/usr/lib/libx.dylib"}"/></frame>`
	).join("");
	const REFS = Array.from({ length: 24 }, (_, i) => `<frame ref="${100 + i}"/>`).join("");

	async function* generate(targetBytes: number): AsyncGenerator<string> {
		yield HEAD;
		yield `<row><sample-time id="1" fmt="x">0</sample-time><thread id="2" fmt="Main Thread 0x1 (A, pid: 1)"/><weight id="3" fmt="1 ms">1000000</weight><backtrace id="4">${FRAMES}</backtrace></row>\n`;
		let bytes = 0;
		for (let i = 0; bytes < targetBytes; i++) {
			const row = `<row><sample-time id="${10 + i * 2}" fmt="t">${i * 1_000_000}</sample-time><thread ref="2"/><weight ref="3"/><backtrace id="${11 + i * 2}">${REFS}</backtrace></row>\n`;
			bytes += row.length;
			yield row;
		}
		yield "</node></trace-query-result>";
	}

	test("a 50MB table streams in bounded memory", async () => {
		const toc = `<trace-toc><run number="1"><data><table schema="time-profile"/></data></run></trace-toc>`;
		const deps: TraceDeps = {
			run: async (argv) => ({ exitCode: 0, stdout: argv.includes("--toc") ? toc : "", stderr: "" }),
			readChunks: () => generate(50 * 1024 * 1024),
			remove: () => undefined,
		};
		Bun.gc(true);
		const before = process.memoryUsage().rss;
		const t0 = performance.now();
		const res = await analyzeTrace(deps, "big.trace", { workDir: "/w" });
		const ms = performance.now() - t0;
		const grew = process.memoryUsage().rss - before;
		if (!res.success) throw new Error(res.error.message);
		expect(res.data.sampleCount).toBeGreaterThan(40_000);
		expect(res.data.hotspots[0]?.frame).toBe("fn0");
		expect(ms).toBeLessThan(30_000);
		expect(grew).toBeLessThan(800 * 1024 * 1024);
	}, 60_000);
});
