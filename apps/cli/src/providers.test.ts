import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { androidSnapshotKey, readSnapshotInputs, snapshotName } from "@delacour/warden-core/golden/android-golden";
import {
	markAndroidSnapshotBusy,
	markAndroidSnapshotPending,
	pendingAndroidSnapshots,
	recordAndroidSnapshotLoadFailure,
} from "@delacour/warden-core/golden/android-snapshot-pending";
import { fakeHost } from "@delacour/warden-core/golden/golden.testing";
import { ok } from "@delacour/warden-types/result";
import { androidGoldenDeps, androidSnapshotHook, androidSnapshotPass } from "./golden-deps";
import { providerFor } from "./providers";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner = { kind: "agent", sessionId: "me", cwd: "/" } as const;

describe("providerFor ios", () => {
	test("new sims are cloned from the golden by default", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		ctx = testContext([], { exec: host.exec });
		const created = await providerFor("ios", ctx, owner, { sleep: async () => {} }).create(
			"warden-iphone-17-1",
			"iphone-17"
		);
		expect(created.success && created.data.id).toMatch(/^CLONE-/);
		expect(host.calls.some((c) => c[2] === "clone")).toBe(true);
	});

	test("WARDEN_GOLDEN=0 → plain simctl create", async () => {
		const host = fakeHost();
		ctx = testContext([], { exec: host.exec });
		ctx.env = { ...ctx.env, WARDEN_GOLDEN: "0" };
		const created = await providerFor("ios", ctx, owner).create("warden-iphone-17-1", "iphone-17");
		expect(created.success && created.data.id).toMatch(/^NEW-/);
		expect(host.calls.some((c) => c[2] === "clone")).toBe(false);
	});
});

describe("android snapshot hook (16-3)", () => {
	const SYSDIR = "system-images/android-36/google_apis/arm64-v8a";

	/** A fake SDK + AVD whose current snapshot already exists, so the hook needs no emulator. */
	function fakeSdk(c: TestContext): void {
		const sdk = join(c.cwd, "sdk");
		const avd = join(c.cwd, "avd", "Pixel_10.avd");
		mkdirSync(join(sdk, "emulator"), { recursive: true });
		mkdirSync(join(sdk, SYSDIR), { recursive: true });
		mkdirSync(avd, { recursive: true });
		writeFileSync(join(sdk, "emulator", "source.properties"), "Pkg.Revision=35.4.9\n");
		writeFileSync(join(sdk, SYSDIR, "source.properties"), "Pkg.Revision=5\n");
		writeFileSync(join(avd, "config.ini"), `hw.ramSize=4096\nimage.sysdir.1=${SYSDIR}/\n`);
		c.env = { ...c.env, ANDROID_HOME: sdk, ANDROID_AVD_HOME: join(c.cwd, "avd") };
	}

	test("on by default: names warden's current snapshot of the AVD", async () => {
		ctx = testContext([]);
		fakeSdk(ctx);
		const deps = androidGoldenDeps(ctx, owner);
		const read = await readSnapshotInputs(deps, "Pixel_10");
		if (!read.success || read.data === undefined) throw new Error("no snapshot inputs");
		const name = snapshotName(androidSnapshotKey(read.data.inputs));
		mkdirSync(join(read.data.dir, "snapshots", name), { recursive: true });
		writeFileSync(join(read.data.dir, "snapshots", name, "snapshot.pb"), "pb");
		expect(await androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: name });
	});

	test("WARDEN_ANDROID_SNAPSHOT=0 → none, nothing run", async () => {
		const calls: string[][] = [];
		ctx = testContext([], {
			exec: async (cmd) => {
				calls.push([...cmd]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		fakeSdk(ctx);
		ctx.env = { ...ctx.env, WARDEN_ANDROID_SNAPSHOT: "0" };
		expect(await androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
		expect(calls).toHaveLength(0);
	});

	test("no snapshot yet → none: the claim cold-boots, says so once, and nothing is built (R2)", async () => {
		const calls: string[][] = [];
		ctx = testContext([], {
			exec: async (cmd) => {
				calls.push([...cmd]);
				return { exitCode: 1, stdout: "", stderr: "" };
			},
		});
		fakeSdk(ctx);
		expect(await androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
		expect(calls).toHaveLength(0);
		expect(ctx.stderr.filter((l) => l.includes("no quick-boot snapshot of Pixel_10"))).toHaveLength(1);
		expect(pendingAndroidSnapshots(ctx.db, ctx.now())).toEqual(["Pixel_10"]);
		expect(ctx.db.listLeases()).toHaveLength(0);
	});

	test("an unrecognised WARDEN_ANDROID_SNAPSHOT warns and leaves the config's false in force (R7)", async () => {
		ctx = testContext([]);
		fakeSdk(ctx);
		ctx.env = { ...ctx.env, WARDEN_ANDROID_SNAPSHOT: "nah" };
		writeFileSync(
			join(ctx.cwd, "warden.config.json"),
			JSON.stringify({ projects: [{ name: "app", bundleId: { android: "com.x" } }], android: { snapshot: false } })
		);
		expect(await androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
		expect(ctx.stderr.join("\n")).toContain("WARDEN_ANDROID_SNAPSHOT=nah");
		expect(pendingAndroidSnapshots(ctx.db, ctx.now())).toEqual([]);
	});

	test("android.snapshot: false in warden.config.json → none", async () => {
		ctx = testContext([]);
		fakeSdk(ctx);
		writeFileSync(
			join(ctx.cwd, "warden.config.json"),
			JSON.stringify({ projects: [{ name: "app", bundleId: { android: "com.x" } }], android: { snapshot: false } })
		);
		expect(await androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
	});
});

describe("gc's android snapshot step (R2)", () => {
	const built = { avd: "Pixel_10", name: "warden-0123456789", key: "0123456789", built: true };

	test("builds one pending AVD and reports it", async () => {
		ctx = testContext([]);
		markAndroidSnapshotPending(ctx.db, "Pixel_10");
		let builds = 0;
		const notes = await androidSnapshotPass(ctx, owner, async () => {
			builds++;
			return ok({ built, busy: [] });
		});
		expect(builds).toBe(1);
		expect(notes).toEqual(["built android snapshot warden-0123456789 of Pixel_10"]);
	});

	test("nothing pending, or CI set: no build", async () => {
		ctx = testContext([]);
		const build = async () => {
			throw new Error("must not build");
		};
		expect(await androidSnapshotPass(ctx, owner, build)).toEqual([]);
		markAndroidSnapshotPending(ctx.db, "Pixel_10");
		ctx.env = { ...ctx.env, CI: "true" };
		expect(await androidSnapshotPass(ctx, owner, build)).toEqual([]);
		expect(pendingAndroidSnapshots(ctx.db, ctx.now())).toEqual(["Pixel_10"]);
	});

	test("an AVD a pass found busy is still tried by gc's own pass (S5)", async () => {
		ctx = testContext([]);
		markAndroidSnapshotPending(ctx.db, "Pixel_10");
		markAndroidSnapshotBusy(ctx.db, "Pixel_10", ctx.now());
		let builds = 0;
		await androidSnapshotPass(ctx, owner, async () => {
			builds++;
			return ok({ busy: ["Pixel_10"] });
		});
		expect(builds).toBe(1);
	});

	test("an AVD whose snapshot failed to load three times is not built; the note says how to build it (S2)", async () => {
		ctx = testContext([]);
		for (let i = 0; i < 3; i++) recordAndroidSnapshotLoadFailure(ctx.db, "Pixel_10", ctx.now());
		const notes = await androidSnapshotPass(ctx, owner, async () => {
			throw new Error("must not build");
		});
		expect(notes).toEqual([
			"android snapshot of Pixel_10 does not load on this host: gc no longer rebuilds it (warden golden ensure --platform android --profile pixel-10 does)",
		]);
	});

	test("snapshots off: the pending list is dropped, no build", async () => {
		ctx = testContext([]);
		markAndroidSnapshotPending(ctx.db, "Pixel_10");
		ctx.env = { ...ctx.env, WARDEN_ANDROID_SNAPSHOT: "0" };
		expect(
			await androidSnapshotPass(ctx, owner, async () => {
				throw new Error("must not build");
			})
		).toEqual([]);
		expect(pendingAndroidSnapshots(ctx.db, ctx.now())).toEqual([]);
	});
});
