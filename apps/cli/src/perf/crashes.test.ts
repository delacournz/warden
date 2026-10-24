import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPerfCommand } from "../commands/perf";
import { fakeExec, type TestContext, testContext } from "../testing";
import { type CrashDeps, perfCrashes, registerCrashes } from "./crashes";
import { createSession, sessionDir } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fixtureUrl = (name: string) => new URL(`../../../../packages/perf/fixtures/${name}`, import.meta.url);
const read = (name: string) => readFileSync(fixtureUrl(name), "utf8");
const SIM1 = "11111111-2222-3333-4444-555555555555";
const EMU = "emulator-5554";
const APP = "/sim/Containers/Bundle/Application/AB/ShopApp.app";
const NOW = Date.parse("2026-10-24T10:30:00+13:00");

type Handlers = Array<[string, { stdout?: string; exitCode?: number }]>;

function setup(platform: "ios" | "android", handlers: Handlers) {
	const calls: string[][] = [];
	const id = platform === "ios" ? SIM1 : EMU;
	const c = testContext([], { exec: fakeExec(handlers, calls), now: () => NOW });
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform, id, name: "dev" }, 1);
	const reports = join(c.cwd, "DiagnosticReports");
	mkdirSync(reports, { recursive: true });
	for (const name of ["ips-shopapp-sim1.ips", "ips-shopapp-sim2.ips", "ips-otherapp-sim1.ips"]) {
		copyFileSync(fixtureUrl(name), join(reports, name.replace("ips-", "").replace(".ips", "-2026-10-24-100211.ips")));
	}
	const crashDeps: CrashDeps = { reportsDir: () => reports };
	return { c, calls, crashDeps, deps: fakePerfDeps([{ platform, id, name: "dev" }]) };
}

const iosHandlers = (): Handlers => [
	[`xcrun simctl get_app_container ${SIM1} com.acme.shop app`, { stdout: `${APP}\n` }],
	["plutil -extract CFBundleExecutable", { stdout: "ShopApp\n" }],
];

const json = (c: TestContext) => JSON.parse(c.stdout.join("\n"));

describe("perf crashes ios", () => {
	test("only this app on this simulator, summarised", async () => {
		const { c, deps, crashDeps } = setup("ios", iosHandlers());
		expect(await perfCrashes(c, deps, { json: true, app: "com.acme.shop" }, crashDeps)).toBe(0);
		const doc = json(c);
		expect(doc.result.count).toBe(1);
		const crash = doc.result.crashes[0];
		expect(crash).toMatchObject({
			kind: "crash",
			process: "ShopApp",
			exceptionType: "EXC_BAD_ACCESS",
			signal: "SIGSEGV",
			crashedThread: "com.facebook.react.JavaScript",
			firstAppFrame: "ShopApp +4521772",
		});
		expect(crash.frames.length).toBe(10);
		expect(doc.result.findings[0]).toMatchObject({ kind: "crash", severity: "critical", process: "ShopApp" });
	});

	test("--since", async () => {
		const { c, deps, crashDeps } = setup("ios", iosHandlers());
		await perfCrashes(c, deps, { json: true, app: "com.acme.shop", since: "1m" }, crashDeps);
		expect(json(c).result.count).toBe(0);
		c.stdout.length = 0;
		await perfCrashes(c, deps, { json: true, app: "com.acme.shop", since: "1h" }, crashDeps);
		expect(json(c).result.count).toBe(1);
	});

	test("text output names the first app frame", async () => {
		const { c, deps, crashDeps } = setup("ios", iosHandlers());
		await perfCrashes(c, deps, { app: "com.acme.shop" }, crashDeps);
		const text = c.stdout.join("\n");
		expect(text).toContain("CRASH ShopApp");
		expect(text).toContain("first app frame: ShopApp +4521772");
	});

	test("a missing reports dir is a note, not a failure", async () => {
		const { c, deps } = setup("ios", iosHandlers());
		const code = await perfCrashes(
			c,
			deps,
			{ json: true, app: "com.acme.shop" },
			{ reportsDir: () => join(c.cwd, "nope") }
		);
		expect(code).toBe(0);
		expect(json(c).warnings?.[0]).toContain("no crash reports directory");
	});

	test("copies the raw report into the active session", async () => {
		const { c, deps, crashDeps } = setup("ios", iosHandlers());
		const made = createSession(c, deps.session, {
			device: { udid: SIM1, platform: "ios", name: "dev" },
			target: { udid: SIM1, ownedByCaller: false },
			maxDurationMs: 30_000,
		});
		if (!made.success) throw new Error("session");
		await perfCrashes(c, deps, { json: true, app: "com.acme.shop" }, crashDeps);
		const copied = join(sessionDir(c, made.data.id), "crashes", "shopapp-sim1-2026-10-24-100211.ips");
		expect(existsSync(copied)).toBe(true);
		expect(json(c).result.crashes[0].file).toBe(copied);
	});

	describe("--symbolicate", () => {
		test("dwarfdump UUID match then atos with the load address", async () => {
			const { c, calls, deps, crashDeps } = setup("ios", [
				...iosHandlers(),
				["dwarfdump --uuid /d/ShopApp.app.dSYM", { stdout: read("dwarfdump-uuid.txt") }],
				["atos -arch arm64", { stdout: read("atos-out.txt") }],
			]);
			expect(
				await perfCrashes(
					c,
					deps,
					{ json: true, app: "com.acme.shop", symbolicate: true, dsym: "/d/ShopApp.app.dSYM" },
					crashDeps
				)
			).toBe(0);
			const atos = calls.find((a) => a[0] === "atos");
			expect(atos?.slice(0, 7)).toEqual([
				"atos",
				"-arch",
				"arm64",
				"-o",
				"/Users/chris/builds/ShopApp.app.dSYM/Contents/Resources/DWARF/ShopApp",
				"-l",
				"0x100000000",
			]);
			expect(atos?.[7]).toBe((4294967296 + 4521772).toString(16).replace(/^/, "0x"));
			expect(json(c).result.crashes[0].symbolicated.slice(0, 2)).toEqual([
				"-[CartViewController total] (in ShopApp) (CartViewController.m:42)",
				"main (in ShopApp) (main.m:10)",
			]);
		});

		test("a dSYM from another build is reported, crash still listed", async () => {
			const other = "UUID: 00000000-0000-0000-0000-000000000000 (arm64) /d/DWARF/ShopApp\n";
			const { c, deps, crashDeps } = setup("ios", [...iosHandlers(), ["dwarfdump --uuid", { stdout: other }]]);
			await perfCrashes(c, deps, { json: true, app: "com.acme.shop", symbolicate: true, dsym: "/d/x.dSYM" }, crashDeps);
			const doc = json(c);
			expect(doc.result.count).toBe(1);
			expect(doc.result.crashes[0].symbolicated).toBeUndefined();
			expect(doc.warnings?.[0]).toContain("does not match");
		});

		test("needs --dsym", async () => {
			const { c, deps, crashDeps } = setup("ios", iosHandlers());
			expect(await perfCrashes(c, deps, { json: true, app: "com.acme.shop", symbolicate: true }, crashDeps)).toBe(1);
			expect(json(c).error.message).toContain("--dsym");
		});
	});
});

const androidHandlers = (): Handlers => [
	[`adb -s ${EMU} shell date`, { stdout: "2026-10-24 10:10:00\n" }],
	[`adb -s ${EMU} logcat -b crash -d -v threadtime`, { stdout: read("logcat-crash-buffer.txt") }],
	[`adb -s ${EMU} shell dumpsys dropbox --print data_app_crash`, { stdout: read("dropbox-app-crash.txt") }],
	[`adb -s ${EMU} shell dumpsys dropbox --print data_app_anr`, { stdout: read("dropbox-app-anr.txt") }],
];

describe("perf crashes android", () => {
	test("logcat crash buffer + dropbox, deduped, app only, with an ANR finding", async () => {
		const { c, deps, crashDeps } = setup("android", androidHandlers());
		expect(await perfCrashes(c, deps, { json: true, app: "com.acme.shop" }, crashDeps)).toBe(0);
		const doc = json(c);
		const kinds = doc.result.crashes.map((x: { kind: string; source: string }) => `${x.kind}:${x.source}`);
		expect(kinds).toEqual(["anr:dropbox:data_app_anr", "crash:logcat", "crash:dropbox:data_app_crash"]);
		expect(doc.result.findings.map((f: { kind: string }) => f.kind)).toEqual(["anr", "crash", "crash"]);
		expect(doc.result.notes.join(" ")).toContain("tombstones");
		expect(doc.warnings).toBeUndefined();
	});

	test("--since uses the device clock", async () => {
		const { c, deps, crashDeps } = setup("android", androidHandlers());
		await perfCrashes(c, deps, { json: true, app: "com.acme.shop", since: "6m" }, crashDeps);
		const got = json(c).result.crashes.map((x: { at: string }) => x.at);
		expect(got).toEqual(["2026-10-24 10:05:00", "10-24 10:04:10.100"]);
	});

	test("raw logs go into the active session, redacted", async () => {
		const { c, deps, crashDeps } = setup("android", androidHandlers());
		const made = createSession(c, deps.session, {
			device: { udid: EMU, platform: "android", name: "dev" },
			target: { udid: EMU, ownedByCaller: false },
			maxDurationMs: 30_000,
		});
		if (!made.success) throw new Error("session");
		await perfCrashes(c, deps, { json: true, app: "com.acme.shop" }, crashDeps);
		const dir = join(sessionDir(c, made.data.id), "crashes");
		for (const f of ["logcat-crash.txt", "dropbox-data_app_crash.txt", "dropbox-data_app_anr.txt"])
			expect(existsSync(join(dir, f))).toBe(true);
	});

	test("a failing dumpsys is a warning", async () => {
		const { c, deps, crashDeps } = setup("android", [
			[`adb -s ${EMU} shell date`, { stdout: "2026-10-24 10:10:00\n" }],
			[`adb -s ${EMU} logcat -b crash`, { stdout: read("logcat-crash-buffer.txt") }],
			[`adb -s ${EMU} shell dumpsys`, { exitCode: 1 }],
		]);
		expect(await perfCrashes(c, deps, { json: true, app: "com.acme.shop" }, crashDeps)).toBe(0);
		expect(json(c).warnings?.length).toBe(2);
	});

	test("--symbolicate is iOS only", async () => {
		const { c, deps, crashDeps } = setup("android", androidHandlers());
		expect(
			await perfCrashes(c, deps, { json: true, app: "com.acme.shop", symbolicate: true, dsym: "/d" }, crashDeps)
		).toBe(1);
	});
});

test("crashes is wired onto warden perf with its flags", async () => {
	const { deps } = setup("ios", iosHandlers());
	const c = testContext(["crashes", "--json", "--app", "com.acme.shop", "--symbolicate"], { exec: fakeExec([]) });
	ctx?.cleanup();
	ctx = c;
	c.db.recordDevice({ platform: "ios", id: SIM1, name: "dev" }, 1);
	expect(await createPerfCommand(deps, [registerCrashes]).run(c)).toBe(1);
	expect(JSON.parse(c.stdout.join("\n")).error.code).toBe("usage");
});
