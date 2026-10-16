import { describe, expect, test } from "bun:test";
import { fakeExec } from "./exec";
import { hostInfo } from "./host";

const rules = [
	{ cmd: "sysctl", match: (a: readonly string[]) => a[1] === "hw.model", result: { stdout: "Mac15,6\n" } },
	{
		cmd: "sysctl",
		match: (a: readonly string[]) => a[1] === "machdep.cpu.brand_string",
		result: { stdout: "Apple M3 Pro\n" },
	},
	{ cmd: "sysctl", match: (a: readonly string[]) => a[1] === "hw.ncpu", result: { stdout: "12\n" } },
	{ cmd: "sysctl", match: (a: readonly string[]) => a[1] === "hw.memsize", result: { stdout: "38654705664\n" } },
	{ cmd: "sw_vers", result: { stdout: "15.3\n" } },
	{ cmd: "xcodebuild", result: { stdout: "Xcode 16.2\nBuild version 16C5032a\n" } },
	{ cmd: "java", result: { stderr: 'openjdk version "17.0.9" 2023-10-17\nOpenJDK Runtime\n' } },
	{ cmd: "node", result: { stdout: "v24.19.0\n" } },
	{ cmd: process.execPath, result: { stdout: "warden 0.1.0 (dev, /x)\n" } },
];

describe("hostInfo", () => {
	test("collects every field", async () => {
		const r = await hostInfo(fakeExec(rules), { cliPath: "/cli.ts" });
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toMatchObject({
			model: "Mac15,6",
			cpu: "Apple M3 Pro",
			cores: 12,
			memBytes: 38654705664,
			macos: "15.3",
			xcode: "16.2",
			java: "17.0.9",
			node: "24.19.0",
			bun: Bun.version,
			warden: "0.1.0",
		});
		expect(typeof r.data.loadAvgAtStart).toBe("number");
	});
	test("optional tools missing: fields omitted", async () => {
		const required = rules.filter((r) => ["sysctl", "sw_vers"].includes(r.cmd));
		const r = await hostInfo(fakeExec(required), { wardenVersion: "9.9.9" });
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect("xcode" in r.data).toBe(false);
		expect("java" in r.data).toBe(false);
		expect(r.data.warden).toBe("9.9.9");
	});
	test("required field missing is an error", async () => {
		const r = await hostInfo(fakeExec([]));
		expect(r.success).toBe(false);
	});
});
