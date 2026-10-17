import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { androidSnapshotKey, readSnapshotInputs, snapshotName } from "@delacour/warden-core/golden/android-golden";
import {
	androidSnapshotsGivenUp,
	recordAndroidSnapshotLoadFailure,
} from "@delacour/warden-core/golden/android-snapshot-pending";
import { goldenKey, goldenName } from "@delacour/warden-core/golden/golden";
import { fakeHost, IPHONE_17, RUNTIME_BUILD, RUNTIME_ID } from "@delacour/warden-core/golden/golden.testing";
import { androidGoldenDeps } from "../golden-deps";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { createGoldenCommand } from "./golden";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const KEY = goldenKey({
	xcodeBuild: "17F113",
	runtimeId: RUNTIME_ID,
	runtimeBuild: RUNTIME_BUILD,
	deviceType: IPHONE_17,
});
const GOLDEN = goldenName("iphone-17", KEY);
const instant = { sleep: async () => {} };

function setup(argv: string[], host: ReturnType<typeof fakeHost>): TestContext {
	ctx = testContext(argv, { exec: host.exec });
	ctx.env = { ...ctx.env, WARDEN_SESSION_ID: "me" };
	return ctx;
}

describe("warden golden", () => {
	test("ensure builds once, then reuses", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const cmd = createGoldenCommand(instant);
		const c = setup(["ensure", "--json"], host);
		expect(await cmd.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ name: GOLDEN, built: true });
		c.stdout.length = 0;
		expect(await cmd.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ name: GOLDEN, built: false });
	});

	test("ls lists goldens only", async () => {
		const host = fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "P", name: "warden-iphone-17-1", state: "Shutdown" },
			],
		});
		const c = setup(["ls"], host);
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain(GOLDEN);
		expect(c.stdout.join("\n")).not.toContain("warden-iphone-17-1");
	});

	test("ensure runs under a spinner; build progress is logged above it", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const c = setup(["ensure"], host);
		const ui = scriptedUi();
		c.ui = ui;
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(ui.events[0]).toBe("spin: ensuring golden iphone-17 image…");
		expect(ui.events).toContain(`ok: golden ${GOLDEN} built`);
		expect(ui.events.at(-1)).toBe("stop");
		expect(c.stdout.join("\n")).toContain(`${GOLDEN}`);
	});

	function goldenHost() {
		return fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "P", name: "warden-iphone-17-1", state: "Shutdown" },
			],
		});
	}

	test("prune --all --yes deletes goldens only", async () => {
		const host = goldenHost();
		const c = setup(["prune", "--all", "--yes", "--json"], host);
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(host.sims.map((s) => s.udid)).toEqual(["P"]);
		expect(JSON.parse(c.stdout.join("\n")).map((g: { udid: string }) => g.udid)).toEqual(["G"]);
	});

	test("prune --all without a terminal needs --yes", async () => {
		const host = goldenHost();
		const c = setup(["prune", "--all"], host);
		expect(await createGoldenCommand(instant).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--yes");
		expect(host.sims).toHaveLength(2);
	});

	test("prune --all in a terminal asks first", async () => {
		const host = goldenHost();
		const c = setup(["prune", "--all"], host);
		const ui = scriptedUi({ interactive: true, confirm: [true] });
		c.ui = ui;
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(ui.events[0]).toBe("confirm: Delete all 1 golden image(s)?");
		expect(ui.events).toContain("spin: deleting golden images…");
		expect(host.sims.map((s) => s.udid)).toEqual(["P"]);
	});

	test("prune --all declined / cancelled → exit 1, nothing deleted", async () => {
		for (const answer of [false, undefined]) {
			const host = goldenHost();
			const c = setup(["prune", "--all"], host);
			const ui = scriptedUi({ interactive: true, confirm: [answer] });
			c.ui = ui;
			expect(await createGoldenCommand(instant).run(c)).toBe(1);
			expect(ui.events).toContain("cancelled: Aborted.");
			expect(host.sims).toHaveLength(2);
			c.cleanup();
			ctx = undefined;
		}
	});

	test("prune (stale only) never asks", async () => {
		const host = goldenHost();
		const c = setup(["prune"], host);
		const ui = scriptedUi({ interactive: true });
		c.ui = ui;
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(ui.events.some((e) => e.startsWith("confirm"))).toBe(false);
	});

	test("unknown / missing subcommand → exit 1", async () => {
		expect(await createGoldenCommand(instant).run(setup(["nope"], fakeHost()))).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("unknown command 'nope'");
		ctx?.cleanup();
		expect(await createGoldenCommand(instant).run(setup([], fakeHost()))).toBe(1);
	});
});

describe("warden golden --platform android (16-3)", () => {
	const SYSDIR = "system-images/android-36/google_apis/arm64-v8a";
	const owner = { kind: "agent", sessionId: "me", cwd: "/" } as const;

	/** Fake SDK with one AVD (Pixel_10); `adb devices` lists nothing running. */
	function androidSetup(argv: string[]): TestContext {
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			if (joined.endsWith("emulator -list-avds")) return { exitCode: 0, stdout: "Pixel_10\n", stderr: "" };
			if (joined.endsWith("adb devices -l")) return { exitCode: 0, stdout: "List of devices attached\n\n", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: `unexpected ${joined}` };
		};
		const c = testContext(argv, { exec });
		const sdk = join(c.cwd, "sdk");
		const avd = join(c.cwd, "avd", "Pixel_10.avd");
		mkdirSync(join(sdk, "emulator"), { recursive: true });
		mkdirSync(join(sdk, SYSDIR), { recursive: true });
		mkdirSync(avd, { recursive: true });
		writeFileSync(join(sdk, "emulator", "source.properties"), "Pkg.Revision=35.4.9\n");
		writeFileSync(join(sdk, SYSDIR, "source.properties"), "Pkg.Revision=5\n");
		writeFileSync(join(avd, "config.ini"), `hw.ramSize=4096\nimage.sysdir.1=${SYSDIR}/\n`);
		c.env = { ...c.env, WARDEN_SESSION_ID: "me", ANDROID_HOME: sdk, ANDROID_AVD_HOME: join(c.cwd, "avd") };
		ctx = c;
		return c;
	}

	function plant(c: TestContext, name: string): string {
		const snap = join(c.cwd, "avd", "Pixel_10.avd", "snapshots", name);
		mkdirSync(snap, { recursive: true });
		writeFileSync(join(snap, "snapshot.pb"), "pb");
		return snap;
	}

	async function current(c: TestContext): Promise<string> {
		const read = await readSnapshotInputs(androidGoldenDeps(c, owner), "Pixel_10");
		if (!read.success || read.data === undefined) throw new Error("no inputs");
		return snapshotName(androidSnapshotKey(read.data.inputs));
	}

	test("ensure reuses the AVD's current snapshot", async () => {
		const c = androidSetup(["ensure", "--platform", "android", "--json"]);
		const name = await current(c);
		plant(c, name);
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ avd: "Pixel_10", name, built: false });
	});

	test("ensure forgets the AVD's load failures, so gc builds it again (S2)", async () => {
		const c = androidSetup(["ensure", "--platform", "android", "--json"]);
		for (let i = 0; i < 3; i++) recordAndroidSnapshotLoadFailure(c.db, "Pixel_10", c.now());
		plant(c, await current(c));
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(androidSnapshotsGivenUp(c.db)).toEqual([]);
		expect(recordAndroidSnapshotLoadFailure(c.db, "Pixel_10", c.now()).loadFailures).toBe(1);
	});

	test("ls lists warden snapshots with whether they are current", async () => {
		const c = androidSetup(["ls", "--platform", "android", "--json"]);
		const name = await current(c);
		plant(c, name);
		plant(c, "warden-0000000000");
		plant(c, "default_boot");
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		const rows: Array<{ name: string; current: boolean }> = JSON.parse(c.stdout.join("\n"));
		expect(rows.map((r) => [r.name, r.current]).sort()).toEqual(
			[
				[name, true],
				["warden-0000000000", false],
			].sort()
		);
	});

	test("prune deletes stale snapshots only; --all --yes deletes every warden snapshot", async () => {
		const c = androidSetup(["prune", "--platform", "android", "--json"]);
		const mine = plant(c, await current(c));
		const stale = plant(c, "warden-0000000000");
		const userBoot = plant(c, "default_boot");
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(mine)).toBe(true);
		c.argv = ["prune", "--platform", "android", "--all", "--yes", "--json"];
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(existsSync(mine)).toBe(false);
		expect(existsSync(userBoot)).toBe(true);
	});

	test("an unknown --platform → exit 1", async () => {
		const c = androidSetup(["ls", "--platform", "windows"]);
		expect(await createGoldenCommand(instant).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--platform");
	});
});
