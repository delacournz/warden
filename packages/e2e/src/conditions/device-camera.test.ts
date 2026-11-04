import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConditionArea, ConditionValues } from "@delacour/warden-core/conditions/conditions.types";
import { fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { E2eEnv } from "../env";
import { E2eError } from "../errors";
import type { ConditionEvent } from "./condition-events";
import { createDeviceConditions } from "./device-conditions";
import type { ConditionRecorder } from "./lease-recorder";
import type { TickerClock } from "./route-ticker";

const env: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
};

const clock: TickerClock = { now: () => 1000, sleep: async () => undefined };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(16)]);

let root: string;
let specDir: string;
let home: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "warden-device-camera-"));
	specDir = join(root, "e2e");
	home = join(root, "home");
	mkdirSync(join(specDir, "fixtures"), { recursive: true });
	writeFileSync(join(specDir, "fixtures", "a.png"), PNG);
	writeFileSync(join(specDir, "fixtures", "b.png"), PNG_B);
	writeFileSync(join(specDir, "fixtures", "clip.mp4"), MP4);
	writeFileSync(join(specDir, "fixtures", "notes.txt"), "not media");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

type Recorded = { kind: "record" | "settle"; area: ConditionArea; value: unknown };

function setup(extra: Partial<E2eEnv> = {}, onCall?: Parameters<typeof fakeDriver>[0]["onCall"]) {
	const driver = fakeDriver({ screens: [snapshotOf([])], ...(onCall ? { onCall } : {}) });
	const events: ConditionEvent[] = [];
	const recorded: Recorded[] = [];
	const recorder: ConditionRecorder = {
		record: <A extends ConditionArea>(area: A, value: ConditionValues[A]) =>
			void recorded.push({ kind: "record", area, value }),
		settle: <A extends ConditionArea>(area: A, value: ConditionValues[A]) =>
			void recorded.push({ kind: "settle", area, value }),
	};
	const c = createDeviceConditions({
		driver,
		env: { ...env, ...extra },
		signal: () => undefined,
		sink: (e) => void events.push(e),
		tickerClock: clock,
		recorder,
		log: () => undefined,
		wardenHome: home,
		specDir: () => specDir,
	});
	return { c, driver, events, recorded };
}

describe("device.camera.set", () => {
	test("stages the asset relative to the spec, defaults to the back camera, records and emits", async () => {
		const { c, driver, events, recorded } = setup();
		const state = await c.camera.set("fixtures/a.png");
		const call = driver.callsOf("camera")[0];
		expect(call?.op).toMatchObject({ back: { kind: "image" } });
		expect(call?.op).not.toHaveProperty("front");
		const staged = call?.op?.back?.path ?? "";
		expect(staged.startsWith(join(home, "camera", "UDID"))).toBe(true);
		expect(readFileSync(staged).equals(PNG)).toBe(true);
		expect(state.feeds.back?.path).toBe(staged);
		expect(recorded).toEqual([{ kind: "record", area: "camera", value: state.feeds }]);
		expect(events[0]).toMatchObject({ area: "camera", value: state.feeds });
	});

	test("facing both feeds both cameras; front keeps the other facing's feed", async () => {
		const { c } = setup();
		const both = await c.camera.set("fixtures/a.png", { facing: "both" });
		expect(Object.keys(both.feeds).sort()).toEqual(["back", "front"]);
		const next = await c.camera.set("fixtures/b.png", { facing: "front" });
		expect(readFileSync(next.feeds.front?.path ?? "").equals(PNG_B)).toBe(true);
		expect(readFileSync(next.feeds.back?.path ?? "").equals(PNG)).toBe(true);
	});

	test("a video loops unless loop is false", async () => {
		const { c } = setup();
		expect((await c.camera.set("fixtures/clip.mp4")).feeds.back).toMatchObject({ kind: "video", loop: true });
		expect((await c.camera.set("fixtures/clip.mp4", { loop: false })).feeds.back).toMatchObject({
			kind: "video",
			loop: false,
		});
	});

	test("an absolute path is used as is", async () => {
		const { c } = setup();
		const state = await c.camera.set(join(specDir, "fixtures", "a.png"));
		expect(state.feeds.back?.kind).toBe("image");
	});

	test("surfaces appliesOnLaunch / appliesOnCameraOpen / rebooted from the driver", async () => {
		const { c } = setup({}, (call) =>
			call.method === "camera"
				? { data: { feeds: call.op ?? {}, appliesOnLaunch: true, appliesOnCameraOpen: true, rebooted: true } }
				: undefined
		);
		const state = await c.camera.set("fixtures/a.png");
		expect(state).toMatchObject({ appliesOnLaunch: true, appliesOnCameraOpen: true, rebooted: true });
	});

	test("a missing file fails with E_CAMERA_NOT_FOUND and never reaches the driver", async () => {
		const { c, driver } = setup();
		const failure = await c.camera.set("fixtures/missing.png").catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(E2eError);
		expect((failure as E2eError).message).toContain("E_CAMERA_NOT_FOUND");
		expect(driver.callsOf("camera")).toHaveLength(0);
	});

	test("an unsupported file fails with E_CAMERA_MEDIA", async () => {
		const { c } = setup();
		const failure = await c.camera.set("fixtures/notes.txt").catch((e: unknown) => e);
		expect((failure as E2eError).message).toContain("E_CAMERA_MEDIA");
	});

	test("a driver failure (E_CAMERA_DEVICE) keeps its code and message", async () => {
		const { c } = setup({}, (call) =>
			call.method === "camera"
				? { error: { code: "E_UNSUPPORTED", message: "E_CAMERA_DEVICE: claim with --camera", retryable: false } }
				: undefined
		);
		const failure = await c.camera.set("fixtures/a.png").catch((e: unknown) => e);
		expect((failure as E2eError).message).toContain("claim with --camera");
	});

	test("an unknown facing is an INVALID_ARGUMENT", async () => {
		const { c } = setup();
		const failure = await c.camera
			.set("fixtures/a.png", { facing: "side" as unknown as "back" })
			.catch((e: unknown) => e);
		expect((failure as E2eError).code).toBe("INVALID_ARGUMENT");
	});
});

describe("device.camera.clear and status", () => {
	test("clear(facing) leaves the other facing; clear() takes every feed off and settles the record", async () => {
		const { c, driver, recorded } = setup();
		await c.camera.set("fixtures/a.png", { facing: "both" });
		const one = await c.camera.clear("back");
		expect(Object.keys(one.feeds)).toEqual(["front"]);
		await c.camera.clear();
		expect(driver.callsOf("camera").at(-1)?.op).toBeNull();
		expect(recorded.at(-1)).toEqual({ kind: "settle", area: "camera", value: {} });
	});

	test("status reports the feeds in place", async () => {
		const { c } = setup();
		expect((await c.camera.status()).feeds).toEqual({});
		await c.camera.set("fixtures/a.png");
		expect(Object.keys((await c.camera.status()).feeds)).toEqual(["back"]);
	});
});

describe("camera at the start and end of a test", () => {
	test("teardown takes the camera off when the test set it", async () => {
		const { c, driver } = setup();
		await c.camera.set("fixtures/a.png");
		expect(c.internals.dirty()).toBe(true);
		await c.internals.teardown();
		expect(driver.callsOf("camera").at(-1)?.op).toBeNull();
	});

	test("the suite's camera is applied by the baseline and put back by teardown", async () => {
		const cameraFeeds = {
			back: { path: join(specDir, "fixtures", "a.png"), loop: true },
			front: { path: join(specDir, "fixtures", "clip.mp4"), loop: false },
		};
		const { c, driver } = setup({ cameraFeeds });
		expect(c.internals.declared).toBe(true);
		await c.internals.applyBaseline();
		expect(driver.callsOf("camera")[0]?.op).toMatchObject({
			back: { kind: "image" },
			front: { kind: "video", loop: false },
		});
		expect(c.internals.dirty()).toBe(false);
		await c.camera.set("fixtures/b.png", { facing: "front" });
		await c.internals.teardown();
		expect(driver.callsOf("camera").at(-1)?.op).toMatchObject({
			back: { kind: "image" },
			front: { kind: "video", loop: false },
		});
	});

	test("without a suite camera nothing is declared", () => {
		expect(setup().c.internals.declared).toBe(false);
	});
});

describe("camera path resolution", () => {
	test("by default a relative path is resolved against the calling spec file", async () => {
		const fixture = join(import.meta.dir, "camera-path-fixture.tmp.png");
		writeFileSync(fixture, PNG);
		try {
			const c = createDeviceConditions({
				driver: fakeDriver({ screens: [snapshotOf([])] }),
				env,
				signal: () => undefined,
				tickerClock: clock,
				log: () => undefined,
				wardenHome: home,
			});
			const state = await c.camera.set("camera-path-fixture.tmp.png");
			expect(state.feeds.back?.kind).toBe("image");
		} finally {
			rmSync(fixture, { force: true });
		}
	});
});
