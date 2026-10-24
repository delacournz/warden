import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StopOutcome } from "./helper";
import { type HelperLoader, stopHelperAfter } from "./stop-helper-after";

const IOS = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const PHONE = "00008110-001A2B3C4D5E6F70";
const ANDROID = "emulator-5554";
const errs: string[] = [];
const ctx = { env: { WARDEN_HOME: "/h" }, now: () => 0, err: (line: string) => errs.push(line) };
const noHost = () => false;

function loader(stop: StopOutcome = { stopped: true, how: "shutdown" }): {
	load: HelperLoader;
	loads: number;
	stopped: string[];
} {
	const seen = { loads: 0, stopped: [] as string[] };
	return {
		load: async () => {
			seen.loads += 1;
			return {
				stopHelper: async (_host, udid) => {
					seen.stopped.push(udid);
					return stop;
				},
				stopAndroidHost: async (_host, serial) => {
					seen.stopped.push(serial);
					return stop;
				},
			};
		},
		get loads() {
			return seen.loads;
		},
		stopped: seen.stopped,
	};
}

describe("stopHelperAfter", () => {
	test("stops the helper of a released iOS device", async () => {
		const l = loader();
		await stopHelperAfter(ctx, l.load)(IOS);
		await stopHelperAfter(ctx, l.load)(PHONE);
		expect(l.stopped).toEqual([IOS, PHONE]);
	});

	test("a helper kept with a warning (its command line unreadable) says so on stderr, once (S4)", async () => {
		errs.length = 0;
		const warning = "could not stop warden-simd (pid 777): its command line could not be read, so it was left running";
		const l = loader({ stopped: false, how: "none", warning });
		await stopHelperAfter(ctx, l.load)(IOS);
		expect(errs).toEqual([`warden: ${warning}`]);
		errs.length = 0;
		await stopHelperAfter(ctx, loader().load)(IOS);
		expect(errs).toEqual([]);
	});

	test("an Android serial with no recorded host, or a CDP target: nothing is loaded for it", async () => {
		const l = loader();
		await stopHelperAfter(ctx, l.load, noHost)(ANDROID);
		await stopHelperAfter(ctx, l.load, noHost)("chromium-cdp-9222");
		expect(l.loads).toBe(0);
		expect(l.stopped).toEqual([]);
	});

	test("an Android serial with a recorded host has it stopped", async () => {
		const l = loader();
		await stopHelperAfter(ctx, l.load, (_host, serial) => serial === ANDROID)(ANDROID);
		expect(l.loads).toBe(1);
		expect(l.stopped).toEqual([ANDROID]);
	});

	test("the helper module is loaded when a stop happens, not before", async () => {
		const l = loader();
		const after = stopHelperAfter(ctx, l.load);
		expect(l.loads).toBe(0);
		await after(IOS);
		expect(l.loads).toBe(1);
	});
});

describe("startup cost", () => {
	const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
	const staticImports = (source: string) =>
		[...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);

	test("the module imports no helper, driver or e2e code statically", () => {
		const imports = staticImports(read("stop-helper-after.ts"));
		expect(imports.filter((spec) => /helper|driver|close|warden-e2e/.test(spec ?? ""))).toEqual([]);
	});

	test("release, gc and the hook reach the helper only through it", () => {
		for (const file of ["../commands/release.ts", "../commands/hook.ts", "../commands/gc.ts", "../lease-session.ts"]) {
			const imports = staticImports(read(file));
			expect(imports.filter((spec) => /agent-ui\/(close|helper)$/.test(spec ?? ""))).toEqual([]);
		}
	});
});
