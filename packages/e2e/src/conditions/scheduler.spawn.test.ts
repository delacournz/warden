import { describe, expect, test } from "bun:test";
import { spawnDetachedScheduler } from "./scheduler.spawn";

describe("spawnDetachedScheduler", () => {
	const config = {
		platform: "android",
		id: "emulator-5554",
		adb: "adb",
		mode: "flap",
		flap: { upMs: 10_000, downMs: 3000 },
	} as const;

	test("spawns runtime + main + config and returns the pid as an OwnedProcess", () => {
		let argv: readonly string[] = [];
		const res = spawnDetachedScheduler(
			config,
			(a) => {
				argv = a;
				return { pid: 77 };
			},
			"/bin/bun",
			"/x/scheduler.main.ts"
		);
		expect(res).toEqual({ success: true, data: { kind: "pid", pid: 77 } });
		expect(argv.slice(0, 2)).toEqual(["/bin/bun", "/x/scheduler.main.ts"]);
		expect(JSON.parse(argv[2] as string)).toEqual(config);
	});

	test("a spawn that yields nothing is an error", () => {
		expect(spawnDetachedScheduler(config, () => undefined).success).toBe(false);
	});
});
