import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AndroidGolden, androidSnapshotModel } from "@delacour/warden-core/golden/android-golden";
import { AndroidSnapshotPending } from "@delacour/warden-core/golden/android-snapshot-pending";
import { goldenTesting } from "@delacour/warden-core/testing/golden.testing";
import { leaseHostFixture, type TestLeaseHost } from "@delacour/warden-leasing/testing/lease-host.testing";
import type { InventoryDevice } from "@delacour/warden-store/types";
import { resultFactory } from "@delacour/warden-types/result";
import { leaseConditions } from "./conditions/conditions";
import { hostDeps } from "./host-deps";

let ctx: TestLeaseHost | undefined;

/** Every message the host logged, in order. */
const messages = (c: TestLeaseHost): string[] => c.events.flatMap((e) => ("message" in e ? [e.message] : []));
afterEach(() => ctx?.cleanup());

const owner = { kind: "agent", sessionId: "me", cwd: "/" } as const;

describe("providerFor ios", () => {
	test("new sims are cloned from the golden by default", async () => {
		const host = goldenTesting.fakeHost({ migrationPolls: 0 });
		ctx = leaseHostFixture.build({ exec: host.exec });
		const created = await hostDeps
			.providerFor("ios", ctx, owner, { sleep: async () => {} })
			.create("warden-iphone-17-1", "iphone-17");
		expect(created.success && created.data.id).toMatch(/^CLONE-/);
		expect(host.calls.some((c) => c[2] === "clone")).toBe(true);
	});

	test("WARDEN_GOLDEN=0 → plain simctl create", async () => {
		const host = goldenTesting.fakeHost();
		ctx = leaseHostFixture.build({ exec: host.exec });
		ctx.env = { ...ctx.env, WARDEN_GOLDEN: "0" };
		const created = await hostDeps.providerFor("ios", ctx, owner).create("warden-iphone-17-1", "iphone-17");
		expect(created.success && created.data.id).toMatch(/^NEW-/);
		expect(host.calls.some((c) => c[2] === "clone")).toBe(false);
	});
});

describe("android snapshot hook (16-3)", () => {
	const SYSDIR = "system-images/android-36/google_apis/arm64-v8a";

	/** A fake SDK + AVD whose current snapshot already exists, so the hook needs no emulator. */
	function fakeSdk(c: TestLeaseHost): void {
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
		ctx = leaseHostFixture.build();
		fakeSdk(ctx);
		const deps = hostDeps.androidGoldenDeps(ctx, owner);
		const read = await new AndroidGolden(deps).readInputs("Pixel_10");
		if (!read.success || read.data === undefined) throw new Error("no snapshot inputs");
		const name = androidSnapshotModel.name(androidSnapshotModel.key(read.data.inputs));
		mkdirSync(join(read.data.dir, "snapshots", name), { recursive: true });
		writeFileSync(join(read.data.dir, "snapshots", name, "snapshot.pb"), "pb");
		expect(await hostDeps.androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: name });
	});

	test("WARDEN_ANDROID_SNAPSHOT=0 → none, nothing run", async () => {
		const calls: string[][] = [];
		ctx = leaseHostFixture.build({
			exec: async (cmd) => {
				calls.push([...cmd]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		fakeSdk(ctx);
		ctx.env = { ...ctx.env, WARDEN_ANDROID_SNAPSHOT: "0" };
		expect(await hostDeps.androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
		expect(calls).toHaveLength(0);
	});

	test("no snapshot yet → none: the claim cold-boots, says so once, and nothing is built (R2)", async () => {
		const calls: string[][] = [];
		ctx = leaseHostFixture.build({
			exec: async (cmd) => {
				calls.push([...cmd]);
				return { exitCode: 1, stdout: "", stderr: "" };
			},
		});
		fakeSdk(ctx);
		expect(await hostDeps.androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
		expect(calls).toHaveLength(0);
		expect(messages(ctx).filter((l) => l.includes("no quick-boot snapshot of Pixel_10"))).toHaveLength(1);
		expect(new AndroidSnapshotPending(ctx.db).pending(ctx.now())).toEqual(["Pixel_10"]);
		expect(ctx.db.listLeases()).toHaveLength(0);
	});

	test("an unrecognised WARDEN_ANDROID_SNAPSHOT warns and leaves the config's false in force (R7)", async () => {
		ctx = leaseHostFixture.build();
		fakeSdk(ctx);
		ctx.env = { ...ctx.env, WARDEN_ANDROID_SNAPSHOT: "nah" };
		writeFileSync(
			join(ctx.cwd, "warden.config.json"),
			JSON.stringify({ projects: [{ name: "app", bundleId: { android: "com.x" } }], android: { snapshot: false } })
		);
		expect(await hostDeps.androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
		expect(messages(ctx).join("\n")).toContain("WARDEN_ANDROID_SNAPSHOT=nah");
		expect(new AndroidSnapshotPending(ctx.db).pending(ctx.now())).toEqual([]);
	});

	test("android.snapshot: false in warden.config.json → none", async () => {
		ctx = leaseHostFixture.build();
		fakeSdk(ctx);
		writeFileSync(
			join(ctx.cwd, "warden.config.json"),
			JSON.stringify({ projects: [{ name: "app", bundleId: { android: "com.x" } }], android: { snapshot: false } })
		);
		expect(await hostDeps.androidSnapshotHook(ctx, owner)("Pixel_10")).toEqual({ success: true, data: undefined });
	});
});

describe("gc's android snapshot step (R2)", () => {
	const built = { avd: "Pixel_10", name: "warden-0123456789", key: "0123456789", built: true };

	test("builds one pending AVD and reports it", async () => {
		ctx = leaseHostFixture.build();
		new AndroidSnapshotPending(ctx.db).markPending("Pixel_10");
		let builds = 0;
		const notes = await hostDeps.androidSnapshotPass(ctx, owner, async () => {
			builds++;
			return resultFactory.ok({ built, busy: [] });
		});
		expect(builds).toBe(1);
		expect(notes).toEqual(["built android snapshot warden-0123456789 of Pixel_10"]);
	});

	test("nothing pending, or CI set: no build", async () => {
		ctx = leaseHostFixture.build();
		const build = async () => {
			throw new Error("must not build");
		};
		expect(await hostDeps.androidSnapshotPass(ctx, owner, build)).toEqual([]);
		new AndroidSnapshotPending(ctx.db).markPending("Pixel_10");
		ctx.env = { ...ctx.env, CI: "true" };
		expect(await hostDeps.androidSnapshotPass(ctx, owner, build)).toEqual([]);
		expect(new AndroidSnapshotPending(ctx.db).pending(ctx.now())).toEqual(["Pixel_10"]);
	});

	test("an AVD a pass found busy is still tried by gc's own pass (S5)", async () => {
		ctx = leaseHostFixture.build();
		new AndroidSnapshotPending(ctx.db).markPending("Pixel_10");
		new AndroidSnapshotPending(ctx.db).markBusy("Pixel_10", ctx.now());
		let builds = 0;
		await hostDeps.androidSnapshotPass(ctx, owner, async () => {
			builds++;
			return resultFactory.ok({ busy: ["Pixel_10"] });
		});
		expect(builds).toBe(1);
	});

	test("an AVD whose snapshot failed to load three times is not built; the note says how to build it (S2)", async () => {
		ctx = leaseHostFixture.build();
		for (let i = 0; i < 3; i++) new AndroidSnapshotPending(ctx.db).recordLoadFailure("Pixel_10", ctx.now());
		const notes = await hostDeps.androidSnapshotPass(ctx, owner, async () => {
			throw new Error("must not build");
		});
		expect(notes).toEqual([
			"android snapshot of Pixel_10 does not load on this host: gc no longer rebuilds it (warden golden ensure --platform android --profile pixel-10 does)",
		]);
	});

	test("snapshots off: the pending list is dropped, no build", async () => {
		ctx = leaseHostFixture.build();
		new AndroidSnapshotPending(ctx.db).markPending("Pixel_10");
		ctx.env = { ...ctx.env, WARDEN_ANDROID_SNAPSHOT: "0" };
		expect(
			await hostDeps.androidSnapshotPass(ctx, owner, async () => {
				throw new Error("must not build");
			})
		).toEqual([]);
		expect(new AndroidSnapshotPending(ctx.db).pending(ctx.now())).toEqual([]);
	});
});

describe("leaseConditions / orphanUndo", () => {
	const device = { kind: "device", platform: "ios", id: "1", name: "warden-iphone-17-1" } as const;

	function recordingExec(cmds: string[][]) {
		return async (cmd: readonly string[]) => {
			cmds.push([...cmd]);
			return { exitCode: 0, stdout: "", stderr: "" };
		};
	}

	test("has is false for a lease with nothing set and true once a condition is recorded", () => {
		ctx = leaseHostFixture.build();
		const lease = ctx.db.insertLease({ resource: device, owner, ttlMs: 1000 }, 1);
		const hook = hostDeps.leaseConditions(ctx);
		expect(hook.has(lease)).toBe(false);
		leaseConditions.record(ctx.db, lease.id, "a11y", { contrast: "increased" }, 2);
		expect(hook.has(lease)).toBe(true);
	});

	test("undo resets the device and clears the record", async () => {
		const cmds: string[][] = [];
		ctx = leaseHostFixture.build({ exec: recordingExec(cmds) });
		const lease = ctx.db.insertLease({ resource: device, owner, ttlMs: 1000 }, 1);
		leaseConditions.record(ctx.db, lease.id, "a11y", { contrast: "increased" }, 2);
		const hook = hostDeps.leaseConditions(ctx);
		expect(await hook.undo(lease)).toEqual([]);
		expect(cmds).toContainEqual(["xcrun", "simctl", "ui", "1", "increase_contrast", "disabled"]);
		expect(hook.has(lease)).toBe(false);
	});

	test("undo reports a failed reset and keeps the record", async () => {
		ctx = leaseHostFixture.build({ exec: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }) });
		const lease = ctx.db.insertLease({ resource: device, owner, ttlMs: 1000 }, 1);
		leaseConditions.record(ctx.db, lease.id, "a11y", { contrast: "increased" }, 2);
		const hook = hostDeps.leaseConditions(ctx);
		const notes = await hook.undo(lease);
		expect(notes.length).toBeGreaterThan(0);
		expect(notes[0]).toContain(`conditions on ${lease.id}`);
		expect(hook.has(lease)).toBe(true);
	});

	test("orphanUndo resets what a deleted lease left and empties the orphan table", async () => {
		const cmds: string[][] = [];
		ctx = leaseHostFixture.build({ exec: recordingExec(cmds) });
		const stale = ctx.db.insertLease({ resource: device, owner, ttlMs: 1000 }, 1);
		leaseConditions.record(ctx.db, stale.id, "a11y", { contrast: "increased" }, 2);
		ctx.db.deleteLeases([stale.id]);
		const target: InventoryDevice = {
			platform: "ios",
			id: "1",
			name: device.name,
			state: "booted",
			wardenCreated: true,
		};
		expect(await hostDeps.orphanUndo(ctx)(target)).toEqual([]);
		expect(cmds).toContainEqual(["xcrun", "simctl", "ui", "1", "content_size", "large"]);
		expect(ctx.db.db.query("SELECT COUNT(*) AS n FROM orphan_conditions").get()).toEqual({ n: 0 });
	});
});
