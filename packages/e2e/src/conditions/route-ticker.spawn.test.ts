import { describe, expect, test } from "bun:test";
import { spawnDetachedTicker } from "./route-ticker.spawn";

describe("spawnDetachedTicker", () => {
	const config = { adb: "adb", serial: "emulator-5554", points: [{ lat: 1, lon: 2 }] };

	test("spawns runtime + main + config and returns the pid as an OwnedProcess", () => {
		let argv: readonly string[] = [];
		const res = spawnDetachedTicker(
			config,
			(a) => {
				argv = a;
				return { pid: 4242 };
			},
			"/bin/bun",
			"/x/main.ts"
		);
		expect(res).toEqual({ success: true, data: { kind: "pid", pid: 4242 } });
		expect(argv.slice(0, 2)).toEqual(["/bin/bun", "/x/main.ts"]);
		expect(JSON.parse(argv[2] as string)).toEqual(config);
	});

	test("a spawn that yields nothing is an error", () => {
		expect(spawnDetachedTicker(config, () => undefined).success).toBe(false);
	});
});
