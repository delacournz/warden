import { afterEach, describe, expect, test } from "bun:test";
import { refResolver } from "@delacour/warden-driver/refs";
import { driverFixtures } from "@delacour/warden-driver/testing/driver";
import { type TestContext, testContext } from "../testing";
import { readState, writeState } from "./state";
import { createFileRefStore, createFileStateStore } from "./state-stores";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "U1";
const screen = () =>
	driverFixtures.snapshotOf([
		driverFixtures.el("window", { children: [driverFixtures.el("button", { label: "Go", id: "go" })] }),
	]);

describe("createFileRefStore", () => {
	test("a second store over the same home (another process) sees the snapshot and the next generation", () => {
		ctx = testContext([]);
		const first = createFileRefStore(ctx, UDID);
		const second = createFileRefStore(ctx, UDID);
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
		ctx = testContext([]);
		createFileRefStore(ctx, "A").commit({ takenAt: 1, hash: "h", snapshot: screen() });
		expect(createFileRefStore(ctx, "B").commit({ takenAt: 1, hash: "h", snapshot: screen() }).generation).toBe(1);
	});
});

describe("createFileStateStore", () => {
	test("updates the ops' fields and leaves the generation and helper record alone", () => {
		ctx = testContext([]);
		writeState(ctx, UDID, {
			generation: 7,
			helper: { pid: 42, socket: "/s" },
			app: "old",
			updatedAt: 0,
		});
		const store = createFileStateStore(ctx, UDID);
		expect(store.read()).toEqual({ app: "old" });
		store.update((state) => ({ ...state, app: "com.x", metroUrl: "http://m" }));
		const onDisk = readState(ctx, UDID);
		expect(onDisk).toMatchObject({
			generation: 7,
			helper: { pid: 42, socket: "/s" },
			app: "com.x",
			metroUrl: "http://m",
		});
	});

	test("a key left out of the next state is removed from the file", () => {
		ctx = testContext([]);
		writeState(ctx, UDID, { generation: 0, app: "a", video: { pid: 1, path: "/v.mp4", startedAt: 1 }, updatedAt: 0 });
		const store = createFileStateStore(ctx, UDID);
		store.update(({ video: _stopped, ...rest }) => rest);
		expect(readState(ctx, UDID).video).toBeUndefined();
		expect(readState(ctx, UDID).app).toBe("a");
	});

	test("returning the state it was given writes nothing", () => {
		ctx = testContext([]);
		const store = createFileStateStore(ctx, UDID);
		store.update((state) => state);
		expect(readState(ctx, UDID).updatedAt).toBe(0);
	});
});
