import { afterEach, describe, expect, test } from "bun:test";
import { refResolver } from "@delacour/warden-driver/refs";
import { driverFixtures } from "@delacour/warden-driver/testing/driver";
import { cliTesting, type TestContext } from "../testing";
import { uiStatePersistence } from "./state";
import { uiStateStores } from "./state-stores";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "U1";
const screen = () =>
	driverFixtures.snapshotOf([
		driverFixtures.el("window", { children: [driverFixtures.el("button", { label: "Go", id: "go" })] }),
	]);

describe("createFileRefStore", () => {
	test("a second store over the same home (another process) sees the snapshot and the next generation", () => {
		ctx = cliTesting.testContext([]);
		const first = uiStateStores.createFileRefStore(ctx, UDID);
		const second = uiStateStores.createFileRefStore(ctx, UDID);
		expect(first.last()).toBeUndefined();
		const a = first.commit({ takenAt: 5, hash: "h1", snapshot: screen() });
		expect(a.generation).toBe(1);
		expect(second.last()?.generation).toBe(1);
		expect(refResolver.assign(second.last()?.snapshot ?? screen(), 1).byRef.size).toBeGreaterThan(0);
		const b = second.commit({ takenAt: 9, hash: "h2", snapshot: screen() });
		expect(b.generation).toBe(2);
		expect(first.last()?.generation).toBe(2);
	});

	test("generations are per device", () => {
		ctx = cliTesting.testContext([]);
		uiStateStores.createFileRefStore(ctx, "A").commit({ takenAt: 1, hash: "h", snapshot: screen() });
		expect(
			uiStateStores.createFileRefStore(ctx, "B").commit({ takenAt: 1, hash: "h", snapshot: screen() }).generation
		).toBe(1);
	});
});

describe("createFileStateStore", () => {
	test("updates the ops' fields and leaves the generation and helper record alone", () => {
		ctx = cliTesting.testContext([]);
		uiStatePersistence.writeState(ctx, UDID, {
			generation: 7,
			helper: { pid: 42, socket: "/s" },
			app: "old",
			updatedAt: 0,
		});
		const store = uiStateStores.createFileStateStore(ctx, UDID);
		expect(store.read()).toEqual({ app: "old" });
		store.update((state) => ({ ...state, app: "com.x", metroUrl: "http://m" }));
		const onDisk = uiStatePersistence.readState(ctx, UDID);
		expect(onDisk).toMatchObject({
			generation: 7,
			helper: { pid: 42, socket: "/s" },
			app: "com.x",
			metroUrl: "http://m",
		});
	});

	test("a key left out of the next state is removed from the file", () => {
		ctx = cliTesting.testContext([]);
		uiStatePersistence.writeState(ctx, UDID, {
			generation: 0,
			app: "a",
			video: { pid: 1, path: "/v.mp4", startedAt: 1 },
			updatedAt: 0,
		});
		const store = uiStateStores.createFileStateStore(ctx, UDID);
		store.update(({ video: _stopped, ...rest }) => rest);
		expect(uiStatePersistence.readState(ctx, UDID).video).toBeUndefined();
		expect(uiStatePersistence.readState(ctx, UDID).app).toBe("a");
	});

	test("returning the state it was given writes nothing", () => {
		ctx = cliTesting.testContext([]);
		const store = uiStateStores.createFileStateStore(ctx, UDID);
		store.update((state) => state);
		expect(uiStatePersistence.readState(ctx, UDID).updatedAt).toBe(0);
	});
});
