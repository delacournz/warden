import { describe, expect, test } from "bun:test";
import { bootedUdids, labelledDevices, recordBatch, styleWhenBooted } from "./batch-take";
import type { RecordDeps } from "./record";

const ls = (leases: unknown[]) => JSON.stringify({ leases });
const device = (id: string, label: string) => ({ label, resource: { kind: "device", id } });

describe("labelledDevices", () => {
	test("device leases carrying the label, nothing else", () => {
		const json = ls([
			device("A", "demo-x"),
			device("B", "other"),
			{ label: "demo-x", resource: { kind: "port", id: "8081" } },
		]);
		expect(labelledDevices(json, "demo-x")).toEqual(["A"]);
	});
	test("garbage is no devices", () => {
		expect(labelledDevices("not json", "demo-x")).toEqual([]);
		expect(labelledDevices("{}", "demo-x")).toEqual([]);
	});
});

describe("bootedUdids", () => {
	const out = "    warden-iphone-17-1 (AAA) (Booted)\n    warden-iphone-17-2 (BBB) (Shutdown)\n";
	test("only Booted lines", () => {
		expect(bootedUdids(out, ["AAA", "BBB", "CCC"])).toEqual(["AAA"]);
	});
});

type Call = readonly string[];

function fakeDeps(script: { leases: () => string; devices: () => string }) {
	const calls: Call[] = [];
	let t = 0;
	const deps: RecordDeps = {
		exec: async (cmd) => {
			calls.push(cmd);
			if (cmd.includes("ls")) return { code: 0, stdout: script.leases(), stderr: "" };
			if (cmd.includes("list")) return { code: 0, stdout: script.devices(), stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
		now: () => t,
		sleep: async (ms) => {
			t += ms / 1000;
		},
		log: () => undefined,
	};
	return { deps, calls };
}

describe("styleWhenBooted", () => {
	test("waits for the lease and the boot, styles each sim once, then stops when told", async () => {
		let polls = 0;
		const { deps, calls } = fakeDeps({
			leases: () => (polls < 1 ? ls([]) : ls([device("AAA", "demo-x")])),
			devices: () => (polls < 3 ? "AAA (Shutdown)" : "AAA (Booted)"),
		});
		const done = () => polls++ > 6;
		const styled = await styleWhenBooted(deps, "demo-x", done, 10);
		expect(styled).toEqual(["AAA"]);
		const styling = calls.filter((c) => c.includes("appearance") || c.includes("status_bar"));
		expect(styling).toHaveLength(2);
		expect(styling[0]).toEqual(["xcrun", "simctl", "ui", "AAA", "appearance", "dark"]);
		expect(styling[1]?.slice(0, 4)).toEqual(["xcrun", "simctl", "status_bar", "AAA"]);
		expect(styling[1]).toContain("9:41");
	});
});

describe("recordBatch", () => {
	test("releases the label in finally, even when the run throws", async () => {
		const { deps, calls } = fakeDeps({ leases: () => ls([]), devices: () => "" });
		const run = async () => {
			throw new Error("boom");
		};
		await expect(recordBatch({ label: "demo-x", run, pollMs: 1 }, deps)).rejects.toThrow("boom");
		expect(calls.at(-1)).toEqual(["warden", "release", "--mine", "--label", "demo-x", "--shutdown"]);
	});
	test("clears the status bar override of a styled sim before releasing", async () => {
		const { deps, calls } = fakeDeps({ leases: () => ls([device("AAA", "demo-x")]), devices: () => "AAA (Booted)" });
		const run = async () => {
			await deps.sleep(50);
			return 0;
		};
		await recordBatch({ label: "demo-x", run, pollMs: 10 }, deps);
		const clear = calls.findIndex((c) => c.includes("clear"));
		expect(clear).toBeGreaterThan(-1);
		expect(calls[clear]).toEqual(["xcrun", "simctl", "status_bar", "AAA", "clear"]);
		expect(calls.at(-1)?.[1]).toBe("release");
	});
	test("returns the run's exit code", async () => {
		const { deps } = fakeDeps({ leases: () => ls([]), devices: () => "" });
		expect(await recordBatch({ label: "demo-x", run: async () => 0, pollMs: 1 }, deps)).toBe(0);
	});
});
