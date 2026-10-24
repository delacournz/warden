import { afterEach, describe, expect, test } from "bun:test";
import { fakeExec, type TestContext, testContext } from "../testing";
import { type HelperDeps, helperChecks, helperInfo, importDirFor } from "./doctor-helper";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const HELPER = "/opt/warden/bin/warden-simd";
const MANIFEST = JSON.stringify({ version: "0.1.0", idb: "1.1.8", xcode: "26.6 (17F113)", builtAt: "x" });
const UDID = "11111111-2222-3333-4444-555555555555";

function simctlList(...sims: Array<{ udid: string; state: string }>): string {
	return JSON.stringify({
		devices: {
			"com.apple.CoreSimulator.SimRuntime.iOS-26-5": sims.map((sim) => ({ ...sim, name: "iPhone", isAvailable: true })),
		},
	});
}

/** Fake fs: only these paths exist / are readable. */
function deps(files: Record<string, string>, overrides: Partial<HelperDeps> = {}): HelperDeps {
	return {
		platform: "darwin",
		arch: "arm64",
		execPath: "/opt/warden/bin/warden",
		importDir: "/",
		version: "0.3.0",
		exists: (path) => path in files,
		realpath: (path) => path,
		readFile: (path) => files[path],
		...overrides,
	};
}

function setup(exec = fakeExec([])): TestContext {
	ctx = testContext(["--json"], { exec });
	return ctx;
}

describe("helperChecks", () => {
	test("found next to the binary: path, source and manifest build info; no booted sim → nothing to probe", async () => {
		const c = setup(fakeExec([["xcrun simctl list", { stdout: simctlList({ udid: UDID, state: "Shutdown" }) }]]));
		const rows = await helperChecks(c, deps({ [HELPER]: "", "/opt/warden/bin/manifest.json": MANIFEST }));
		expect(rows).toEqual([
			{
				name: "sim-helper",
				level: "optional",
				status: "ok",
				detail: `${HELPER} (execPath) — warden-simd 0.1.0, idb 1.1.8, xcode 26.6 (17F113)`,
			},
			{ name: "sim-helper-health", level: "optional", status: "ok", detail: "no booted iOS simulator to probe" },
		]);
	});

	test("booted sim: runs `warden-simd --health --udid <first booted>` with a 5s timeout and reports transport + bridge", async () => {
		const calls: string[][] = [];
		const timeouts: Array<number | undefined> = [];
		const health = JSON.stringify({
			ok: true,
			data: { version: "0.1.0", hid: { transport: "indigo" }, ax: { default: "axbridge", bridge: "available" } },
		});
		const c = setup(async (cmd, opts) => {
			calls.push([...cmd]);
			timeouts.push(opts?.timeoutMs);
			if (cmd[0] === "xcrun") {
				return {
					exitCode: 0,
					stdout: simctlList(
						{ udid: "off", state: "Shutdown" },
						{ udid: UDID, state: "Booted" },
						{ udid: "b2", state: "Booted" }
					),
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: `${health}\n`, stderr: "" };
		});
		const rows = await helperChecks(c, deps({ [HELPER]: "" }));
		expect(calls.at(-1)).toEqual([HELPER, "--health", "--udid", UDID]);
		expect(timeouts.at(-1)).toBe(5000);
		expect(rows[0]?.detail).toBe(`${HELPER} (execPath)`);
		expect(rows[1]).toEqual({
			name: "sim-helper-health",
			level: "optional",
			status: "ok",
			detail: `${UDID}: hid.transport=indigo ax.bridge=available`,
		});
	});

	describe("a helper already running on the simulator", () => {
		const standalone = JSON.stringify({
			ok: true,
			data: { hid: { transport: "indigo" }, ax: { default: "axbridge", bridge: "available" } },
		});
		const bootedExec = () =>
			fakeExec([
				["xcrun simctl list", { stdout: simctlList({ udid: UDID, state: "Booted" }) }],
				[HELPER, { stdout: standalone }],
			]);
		const withSocket = (runningHealth: HelperDeps["runningHealth"]) =>
			deps(
				{ [HELPER]: "" },
				{ exists: (path) => path === HELPER || path.endsWith(`simd/${UDID}.sock`), runningHealth }
			);

		test("degraded bridge → warn with the last read failure", async () => {
			const paths: string[] = [];
			const c = setup(bootedExec());
			const rows = await helperChecks(
				c,
				withSocket(async (path) => {
					paths.push(path);
					return {
						ok: true,
						data: {
							ax: {
								default: "axbridge",
								bridge: "degraded",
								lastError: { message: "pid 7 did not respond", agoMs: 4200 },
							},
						},
					};
				})
			);
			expect(paths).toHaveLength(1);
			expect(paths[0]?.endsWith(`simd/${UDID}.sock`)).toBe(true);
			const row = rows.at(-1);
			expect(row?.status).toBe("warn");
			expect(row?.detail).toContain("ax.bridge=degraded");
			expect(row?.detail).toContain("pid 7 did not respond");
			expect(row?.detail).toContain("4s ago");
		});

		test("healthy running helper keeps the ok row", async () => {
			const c = setup(bootedExec());
			const rows = await helperChecks(
				c,
				withSocket(async () => ({ data: { ax: { default: "axbridge", bridge: "available" } } }))
			);
			expect(rows.at(-1)?.status).toBe("ok");
		});

		test("no answer from the running helper → the standalone row stands", async () => {
			const c = setup(bootedExec());
			const rows = await helperChecks(
				c,
				withSocket(async () => undefined)
			);
			expect(rows.at(-1)?.status).toBe("ok");
		});

		test("no socket → the running helper is not asked", async () => {
			let asked = false;
			const c = setup(bootedExec());
			await helperChecks(
				c,
				deps(
					{ [HELPER]: "" },
					{
						runningHealth: async () => {
							asked = true;
							return undefined;
						},
					}
				)
			);
			expect(asked).toBe(false);
		});
	});

	test("bridge not available → warn naming the reason", async () => {
		const health = JSON.stringify({
			ok: true,
			data: { hid: { transport: "dtuhid" }, ax: { default: "axbridge", bridge: "failed", error: "guest crashed" } },
		});
		const c = setup(
			fakeExec([
				["xcrun simctl list", { stdout: simctlList({ udid: UDID, state: "Booted" }) }],
				[HELPER, { stdout: health }],
			])
		);
		const row = (await helperChecks(c, deps({ [HELPER]: "" }))).at(-1);
		expect(row?.status).toBe("warn");
		expect(row?.detail).toContain("hid.transport=dtuhid ax.bridge=failed");
		expect(row?.detail).toContain("guest crashed");
	});

	test("health fails (fatal event / timeout) → warn, not fail", async () => {
		const fatal = JSON.stringify({
			event: "fatal",
			error: { code: "E_NOT_BOOTED", message: "simulator is not booted" },
		});
		const list: [string, { stdout: string }] = [
			"xcrun simctl list",
			{ stdout: simctlList({ udid: UDID, state: "Booted" }) },
		];
		const withFatal = setup(fakeExec([list, [HELPER, { exitCode: 3, stdout: fatal }]]));
		const fatalRow = (await helperChecks(withFatal, deps({ [HELPER]: "" }))).at(-1);
		expect(fatalRow?.status).toBe("warn");
		expect(fatalRow?.detail).toContain("simulator is not booted");

		const timedOut = setup(fakeExec([list, [HELPER, { exitCode: 143 }]]));
		const timeoutRow = (await helperChecks(timedOut, deps({ [HELPER]: "" }))).at(-1);
		expect(timeoutRow?.status).toBe("warn");
		expect(timeoutRow?.detail).toContain("exit 143");
	});

	test("helper missing → warn with the lookup hint and the fetch command; no probe", async () => {
		const calls: string[][] = [];
		const c = setup(fakeExec([], calls));
		const rows = await helperChecks(c, deps({}));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: "sim-helper", status: "warn" });
		expect(rows[0]?.detail).toContain("warden-simd not found");
		expect(rows[0]?.detail).toContain("warden doctor --fetch-helper");
		expect(rows[0]?.detail).toContain("WARDEN_SIMD=/path/to/warden-simd");
		expect(rows[0]?.detail).not.toContain("run `warden doctor` to check");
		expect(calls).toEqual([]);
	});

	test("helper under $WARDEN_HOME/simd/<version> is found (what --fetch-helper fills)", async () => {
		const c = setup();
		const path = `${c.env.WARDEN_HOME}/simd/0.3.0/warden-simd`;
		const rows = await helperChecks(c, deps({ [path]: "" }));
		expect(rows[0]).toMatchObject({ status: "ok", detail: `${path} (warden-home)` });
	});

	test("WARDEN_SIMD pointing at nothing is reported, not skipped", async () => {
		const c = setup();
		c.env = { ...c.env, WARDEN_SIMD: "/nope/warden-simd" };
		const rows = await helperChecks(c, deps({ [HELPER]: "" }));
		expect(rows[0]?.status).toBe("warn");
		expect(rows[0]?.detail).toContain("WARDEN_SIMD=/nope/warden-simd does not exist");
	});

	test("darwin-x64: no helper in this version warns like any missing helper; linux: no rows", async () => {
		const c = setup();
		expect(await helperChecks(c, deps({}, { arch: "x64" }))).toEqual([
			{
				name: "sim-helper",
				level: "optional",
				status: "warn",
				detail:
					"no helper for darwin-x64 in this version — `warden ui` / `warden e2e` cannot drive iOS simulators on this Mac",
			},
		]);
		expect(await helperChecks(c, deps({}, { platform: "linux" }))).toEqual([]);
	});
});

describe("helperInfo", () => {
	test("manifest.json beside the helper, else warden.helper in the package.json above it", () => {
		expect(helperInfo(deps({ "/p/bin/manifest.json": MANIFEST }), "/p/bin/warden-simd")).toEqual({
			version: "0.1.0",
			idb: "1.1.8",
			xcode: "26.6 (17F113)",
		});
		const pkg = JSON.stringify({ warden: { helper: { version: "0.2.0", idb: "1.1.9", xcode: "27.0" } } });
		expect(helperInfo(deps({ "/p/package.json": pkg }), "/p/bin/warden-simd")).toEqual({
			version: "0.2.0",
			idb: "1.1.9",
			xcode: "27.0",
		});
		expect(helperInfo(deps({}), "/p/bin/warden-simd")).toBeUndefined();
		expect(
			helperInfo(deps({ "/p/bin/manifest.json": "junk", "/p/package.json": "{}" }), "/p/bin/warden-simd")
		).toBeUndefined();
	});
});

describe("importDirFor", () => {
	test("source checkouts anchor the native/dist lookup; release builds match nothing", () => {
		expect(importDirFor({ channel: "dev", version: "1", sourceDir: "/src/warden" })).toBe(
			"/src/warden/packages/e2e/src/driver/ios"
		);
		expect(importDirFor({ channel: "local", version: "1", sourceDir: "/src/warden" })).toBe(
			"/src/warden/packages/e2e/src/driver/ios"
		);
		expect(importDirFor({ channel: "local", version: "1" })).toBe("/");
		expect(importDirFor({ channel: "release", version: "1" })).toBe("/");
	});
});
