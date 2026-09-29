import { describe, expect, test } from "bun:test";
import { err, ok } from "@warden/types/result";
import { type EasStepOutcome, type ResolveSource, type ResolveSteps, resolveApp } from "./resolve";

type World = {
	installedHash?: string;
	onDevice?: boolean;
	cache?: string;
	legacy?: string;
	eas?: EasStepOutcome | "error" | "skip";
	build?: string | "error" | "skip";
	/** cache filled by another process while we waited for the lock */
	filledWhileLocked?: string;
	device?: boolean;
};

function steps(world: World) {
	const calls: string[] = [];
	let cache = world.cache;
	let locked = false;
	const s: ResolveSteps = {
		hash: "H",
		cached: () => {
			calls.push("cached");
			return cache;
		},
		legacy: async () => {
			calls.push("legacy");
			if (world.legacy) cache = world.legacy;
			return ok(world.legacy);
		},
		lock: async (fn) => {
			calls.push("lock");
			locked = true;
			if (world.filledWhileLocked) cache = world.filledWhileLocked;
			try {
				return await fn();
			} finally {
				locked = false;
			}
		},
		log: () => {},
	};
	const eas = world.eas;
	if (eas !== "skip") {
		s.eas = async () => {
			calls.push(`eas${locked ? "(locked)" : ""}`);
			if (eas === "error") return err("boom");
			return ok(eas ?? { kind: "miss", reason: "none" });
		};
	}
	if (world.build !== "skip") {
		s.build = async () => {
			calls.push(`build${locked ? "(locked)" : ""}`);
			if (world.build === "error" || world.build === undefined) return err("xcodebuild failed");
			return ok(world.build);
		};
	}
	if (world.device !== false) {
		s.device = {
			installedHash: () => world.installedHash,
			confirm: async () => {
				calls.push("confirm");
				return ok(world.onDevice ?? false);
			},
			install: async (path) => {
				calls.push(`install ${path}`);
				return ok(undefined);
			},
		};
	}
	return { s, calls };
}

type Row = { name: string; world: World; source: ResolveSource | "error"; appPath?: string; calls: string[] };

const rows: Row[] = [
	{
		name: "1 installed at hash + confirmed → skip install",
		world: { installedHash: "H", onDevice: true, cache: "/c/A.app" },
		source: "installed",
		appPath: "/c/A.app",
		calls: ["confirm", "cached"],
	},
	{
		name: "1 installed record but app gone → reinstall from cache",
		world: { installedHash: "H", onDevice: false, cache: "/c/A.app" },
		source: "cache",
		calls: ["confirm", "cached", "install /c/A.app"],
	},
	{
		name: "1 installed at another hash → reinstall (no confirm needed)",
		world: { installedHash: "OLD", cache: "/c/A.app" },
		source: "cache",
		calls: ["cached", "install /c/A.app"],
	},
	{
		name: "2 cache hit → install",
		world: { cache: "/c/A.app" },
		source: "cache",
		calls: ["cached", "install /c/A.app"],
	},
	{
		name: "3 legacy import → install",
		world: { legacy: "/c/L.app" },
		source: "cache",
		calls: ["cached", "legacy", "install /c/L.app"],
	},
	{
		name: "lock waiter: cache filled by the holder → no EAS/build",
		world: { filledWhileLocked: "/c/W.app" },
		source: "cache",
		calls: ["cached", "legacy", "lock", "cached", "install /c/W.app"],
	},
	{
		name: "4 EAS hit (under lock)",
		world: { eas: { kind: "hit", path: "/c/E.app" } },
		source: "eas",
		calls: ["cached", "legacy", "lock", "cached", "eas(locked)", "install /c/E.app"],
	},
	{
		name: "5 EAS miss → local build (under lock)",
		world: { eas: { kind: "miss", reason: "none" }, build: "/c/B.app" },
		source: "build",
		calls: ["cached", "legacy", "lock", "cached", "eas(locked)", "build(locked)", "install /c/B.app"],
	},
	{
		name: "--no-eas → straight to local build",
		world: { eas: "skip", build: "/c/B.app" },
		source: "build",
		calls: ["cached", "legacy", "lock", "cached", "build(locked)", "install /c/B.app"],
	},
	{
		name: "--no-eas --no-build on a miss → error",
		world: { eas: "skip", build: "skip" },
		source: "error",
		calls: ["cached", "legacy", "lock", "cached"],
	},
	{
		name: "EAS miss + --no-build → error",
		world: { build: "skip" },
		source: "error",
		calls: ["cached", "legacy", "lock", "cached", "eas(locked)"],
	},
	{
		name: "local build failure → error, nothing installed",
		world: { build: "error" },
		source: "error",
		calls: ["cached", "legacy", "lock", "cached", "eas(locked)", "build(locked)"],
	},
	{
		name: "no device → resolve the artifact only",
		world: { device: false, cache: "/c/A.app" },
		source: "cache",
		calls: ["cached"],
	},
];

describe("resolveApp decision table", () => {
	for (const row of rows) {
		test(row.name, async () => {
			const { s, calls } = steps(row.world);
			const res = await resolveApp(s);
			if (row.source === "error") {
				expect(res.success).toBe(false);
			} else {
				if (!res.success) throw new Error(res.error);
				expect(res.data.source).toBe(row.source);
				expect(res.data.hash).toBe("H");
				expect(res.data.installed).toBe(row.world.device !== false);
				if (row.appPath) expect(res.data.appPath).toBe(row.appPath);
			}
			expect(calls).toEqual(row.calls);
		});
	}

	test("install failure is an error", async () => {
		const { s } = steps({ cache: "/c/A.app" });
		if (s.device) s.device.install = async () => err("simctl install failed");
		const res = await resolveApp(s);
		expect(res).toEqual({ success: false, error: "simctl install failed" });
	});

	test("error message lists what was skipped", async () => {
		const { s } = steps({ eas: "skip", build: "skip" });
		const res = await resolveApp(s);
		expect(res.success).toBe(false);
		if (!res.success)
			expect(res.error).toBe("no build for fingerprint H: EAS skipped; local build skipped (--no-build)");
	});
});
