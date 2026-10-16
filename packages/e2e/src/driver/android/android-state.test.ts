import { describe, expect, test } from "bun:test";
import {
	type AndroidDeviceState,
	androidStateFile,
	createAndroidStateStore,
	memoryAndroidState,
	parseAnimationValues,
	patchFor,
	planAnimations,
	type StateFs,
} from "./android-state";

const ONES = {
	window_animation_scale: "1.0",
	transition_animation_scale: "1.0",
	animator_duration_scale: "1.0",
};
const ZEROS = {
	window_animation_scale: "0",
	transition_animation_scale: "0",
	animator_duration_scale: "0",
};

/** In-memory `StateFs`; `files` is the whole disk, `fail` makes every write throw. */
function memoryFs(init: Record<string, string> = {}) {
	const files = new Map(Object.entries(init));
	const state = { fail: false, writes: 0 };
	const fs: StateFs = {
		async readFile(path) {
			const text = files.get(path);
			if (text === undefined) throw new Error(`ENOENT ${path}`);
			return text;
		},
		async writeFile(path, data) {
			if (state.fail) throw new Error("EROFS");
			state.writes++;
			files.set(path, data);
		},
		async rename(from, to) {
			const text = files.get(from);
			if (text === undefined) throw new Error(`ENOENT ${from}`);
			files.delete(from);
			files.set(to, text);
		},
		async mkdir() {},
	};
	return { fs, files, state };
}

describe("android state store", () => {
	test("a device nobody has seen has an empty state", async () => {
		const { fs } = memoryFs();
		const store = createAndroidStateStore({ dir: "/home/android", fs });
		expect(await store.read("emulator-5554")).toEqual({});
	});

	test("update writes <dir>/<serial>.json atomically and read gives it back", async () => {
		const { fs, files } = memoryFs();
		const store = createAndroidStateStore({ dir: "/home/android", fs });
		await store.update("emulator-5554", (s) => ({ ...s, sdk: 34, dumpRoute: "tty" }));
		expect([...files.keys()]).toEqual(["/home/android/emulator-5554.json"]);
		expect(await store.read("emulator-5554")).toEqual({ sdk: 34, dumpRoute: "tty" });
		expect(await store.read("emulator-5556")).toEqual({});
	});

	test("update sees what is on disk now, so a field written elsewhere survives", async () => {
		const { fs } = memoryFs();
		const a = createAndroidStateStore({ dir: "/h", fs });
		const b = createAndroidStateStore({ dir: "/h", fs });
		await a.update("s", (s) => ({ ...s, sdk: 34 }));
		await b.update("s", (s) => ({ ...s, dumpRoute: "file" }));
		expect(await a.read("s")).toEqual({ sdk: 34, dumpRoute: "file" });
	});

	test("overlapping updates in one process are applied one after the other", async () => {
		const { fs } = memoryFs();
		const store = createAndroidStateStore({ dir: "/h", fs });
		await Promise.all([
			store.update("s", (s) => ({ ...s, sdk: 33 })),
			store.update("s", (s) => ({ ...s, dumpRoute: "stdout" })),
			store.update("s", (s) => ({ ...s, animations: ONES })),
		]);
		expect(await store.read("s")).toEqual({ sdk: 33, dumpRoute: "stdout", animations: ONES });
	});

	test("the uiad build that cannot run here is remembered with the API level it was learned on", async () => {
		const { fs } = memoryFs();
		const store = createAndroidStateStore({ dir: "/h", fs });
		await store.update("s", patchFor(34, { uiadUnsupported: "779450f8" }));
		expect(await store.read("s")).toEqual({ sdk: 34, uiadUnsupported: "779450f8" });
		await store.update("s", patchFor(35, { dumpRoute: "tty" }));
		expect(await store.read("s")).toEqual({ sdk: 35, dumpRoute: "tty" });
	});

	test("a serial that is not a safe file name cannot escape the directory", () => {
		expect(androidStateFile("/h", "emulator-5554")).toBe("/h/emulator-5554.json");
		expect(androidStateFile("/h", "192.168.1.5:5555")).toBe("/h/192.168.1.5:5555.json");
		expect(androidStateFile("/h", "../../etc/x")).toBe("/h/.._.._etc_x.json");
	});

	test("an unreadable or hand-edited file reads as empty", async () => {
		const bad = [
			"{not json",
			"[]",
			JSON.stringify({ dumpRoute: "carrier-pigeon" }),
			JSON.stringify({ uiadUnsupported: "not a hash; rm -rf" }),
			JSON.stringify({ sdk: "34" }),
			JSON.stringify({ animations: { ...ONES, window_animation_scale: "1; reboot" } }),
			JSON.stringify({ animations: { window_animation_scale: "1.0" } }),
		];
		for (const text of bad) {
			const { fs } = memoryFs({ "/h/s.json": text });
			expect(await createAndroidStateStore({ dir: "/h", fs }).read("s")).toEqual({});
		}
	});

	test("a write that fails (read-only home) is swallowed and logged", async () => {
		const { fs, state } = memoryFs();
		state.fail = true;
		const lines: string[] = [];
		const store = createAndroidStateStore({ dir: "/h", fs, log: (l) => lines.push(l) });
		await store.update("s", (s) => ({ ...s, sdk: 34 }));
		expect(await store.read("s")).toEqual({});
		expect(lines.some((l) => l.includes("could not save"))).toBe(true);
	});

	test("an update that changes nothing writes nothing", async () => {
		const { fs, state } = memoryFs();
		const store = createAndroidStateStore({ dir: "/h", fs });
		await store.update("s", (s) => ({ ...s, sdk: 34 }));
		const before = state.writes;
		await store.update("s", (s) => ({ ...s }));
		expect(state.writes).toBe(before);
	});

	test("the in-memory store behaves the same", async () => {
		const store = memoryAndroidState();
		expect(await store.read("s")).toEqual({});
		await store.update("s", (s: AndroidDeviceState) => ({ ...s, sdk: 30 }));
		expect(await store.read("s")).toEqual({ sdk: 30 });
	});
});

describe("animation scale values", () => {
	test("three values, one per line, in setting order", () => {
		expect(parseAnimationValues("1.0\nnull\n0.5\n")).toEqual({
			window_animation_scale: "1.0",
			transition_animation_scale: "null",
			animator_duration_scale: "0.5",
		});
		expect(parseAnimationValues("1\r\n1\r\n1\r\n")).toEqual({
			window_animation_scale: "1",
			transition_animation_scale: "1",
			animator_duration_scale: "1",
		});
	});

	test("anything else is unreadable", () => {
		expect(parseAnimationValues("")).toBeUndefined();
		expect(parseAnimationValues("1.0\n1.0\n")).toBeUndefined();
		expect(parseAnimationValues("Error: no such setting\n1.0\n1.0\n1.0\n")).toEqual(ONES);
		expect(parseAnimationValues("1.0\n1.0\n1.0\n1.0\n")).toBeUndefined();
	});
});

describe("planAnimations", () => {
	test("scales that were on are what to restore", () => {
		expect(planAnimations(ONES, undefined)).toEqual(ONES);
	});

	test("scales that were already off need no restore", () => {
		expect(planAnimations(ZEROS, undefined)).toBeUndefined();
	});

	test("an unset scale is remembered as unset", () => {
		const unset = { ...ONES, animator_duration_scale: "null" };
		expect(planAnimations(unset, undefined)).toEqual(unset);
	});

	test("zeros left by a crashed run are ours: the originals saved by that run still win", () => {
		expect(planAnimations(ZEROS, ONES)).toEqual(ONES);
		const mixed = { ...ONES, window_animation_scale: "null" };
		expect(planAnimations(ZEROS, mixed)).toEqual(mixed);
	});

	test("a scale someone set since is not ours: keep what is there now", () => {
		const now = { ...ZEROS, transition_animation_scale: "2.0" };
		expect(planAnimations(now, ONES)).toEqual({ ...ONES, transition_animation_scale: "2.0" });
	});

	test("saved originals that are all zero need no restore", () => {
		expect(planAnimations(ZEROS, ZEROS)).toBeUndefined();
	});
});
