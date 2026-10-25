import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@delacour/warden-core/store";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { uiDir } from "./paths";
import {
	commitGeneration,
	readDumpRoute,
	readLastSnapshot,
	readState,
	updateState,
	writeDumpRoute,
	writeLastSnapshot,
	writeState,
} from "./state";

let home: string | undefined;
const stores: Store[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

/** Another process's view of the same `WARDEN_HOME`: its own store connection. */
function connect(dir: string) {
	const store = openStore(join(dir, "warden.db"));
	stores.push(store);
	return { env: { WARDEN_HOME: dir }, now: () => 42, store: () => store };
}

function setup() {
	home = mkdtempSync(join(tmpdir(), "warden-ui-state-"));
	return connect(home);
}

describe("ui state", () => {
	test("lives under $WARDEN_HOME/ui/<udid>; defaults to generation 0", () => {
		const ctx = setup();
		expect(uiDir(ctx, "U1")).toBe(join(home ?? "", "ui", "U1"));
		expect(readState(ctx, "U1")).toEqual({ generation: 0, updatedAt: 0 });
		expect(readLastSnapshot(ctx, "U1")).toBeUndefined();
	});

	test("commitGeneration counts per device in the store, seeded by an older state.json", () => {
		const ctx = setup();
		writeState(ctx, "U1", { generation: 3, metroUrl: "http://localhost:8081", updatedAt: 0 });
		expect(commitGeneration(ctx, "U1", (generation) => generation)).toBe(4);
		expect(commitGeneration(ctx, "U1", (generation) => generation)).toBe(5);
		expect(commitGeneration(ctx, "U2", (generation) => generation)).toBe(1);
		expect(readState(ctx, "U1")).toEqual({ generation: 5, metroUrl: "http://localhost:8081", updatedAt: 42 });
	});

	test("a failing write does not spend the generation", () => {
		const ctx = setup();
		expect(() =>
			commitGeneration(ctx, "U1", () => {
				throw new Error("disk full");
			})
		).toThrow("disk full");
		expect(commitGeneration(ctx, "U1", (generation) => generation)).toBe(1);
	});

	test("two processes taking generations on one WARDEN_HOME never share one, and the stored snapshot is the newest", async () => {
		const ctx = setup();
		const worker = join(import.meta.dir, "state.worker.testing.ts");
		const workers = Array.from({ length: 4 }, () =>
			Bun.spawn([process.execPath, worker, home ?? "", "U1", "25"], { stdout: "pipe", stderr: "inherit" })
		);
		const taken: number[] = [];
		for (const child of workers) {
			expect(await child.exited).toBe(0);
			taken.push(...(JSON.parse(await new Response(child.stdout).text()) as number[]));
		}
		expect([...taken].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, n) => n + 1));
		expect(readLastSnapshot(ctx, "U1")?.generation).toBe(100);
		expect(commitGeneration(ctx, "U1", (generation) => generation)).toBe(101);
	});

	test("three processes each setting a different record through updateState on one WARDEN_HOME keep all three (14-6)", async () => {
		const ctx = setup();
		const worker = join(import.meta.dir, "state.worker.testing.ts");
		const fields = ["helper", "video", "collector"];
		const workers = fields.map((field) =>
			Bun.spawn([process.execPath, worker, home ?? "", "U1", "40", field], { stdout: "pipe", stderr: "inherit" })
		);
		for (const child of workers) expect(await child.exited).toBe(0);
		const state = readState(ctx, "U1");
		expect(state.helper).toEqual({ pid: 40, socket: "/s" });
		expect(state.video).toEqual({ pid: 40, path: "/v.mp4", startedAt: 40 });
		expect(state.collector).toEqual({ pid: 40, startedAt: 40 });
	});

	test("updateState re-reads under the store's transaction, writes what the update returns, and returns it", () => {
		const first = setup();
		const second = connect(home ?? "");
		writeState(first, "U1", { generation: 0, updatedAt: 0, app: "com.acme" });
		let inTransaction = false;
		const store = first.store();
		const transaction = store.transaction.bind(store);
		store.transaction = <T>(fn: () => T): T =>
			transaction(() => {
				inTransaction = true;
				try {
					return fn();
				} finally {
					inTransaction = false;
				}
			});
		// another process wrote between our read and our update: its record survives
		const stale = readState(first, "U1");
		updateState(second, "U1", (state) => ({ ...state, collector: { pid: 9, startedAt: 1 } }));
		const written = updateState(first, "U1", (state) => {
			expect(inTransaction).toBe(true);
			return { ...state, video: { pid: 8, path: "/v", startedAt: 2 } };
		});
		expect(stale.collector).toBeUndefined();
		expect(written).toEqual({
			generation: 0,
			updatedAt: 42,
			app: "com.acme",
			collector: { pid: 9, startedAt: 1 },
			video: { pid: 8, path: "/v", startedAt: 2 },
		});
		expect(readState(first, "U1")).toEqual(written);
	});

	test("updateState writes nothing when the update returns the state it was given; it works without a store", () => {
		const ctx = setup();
		updateState(ctx, "U1", (state) => state);
		expect(existsSync(join(uiDir(ctx, "U1"), "state.json"))).toBe(false);
		const plain = { env: ctx.env, now: ctx.now };
		updateState(plain, "U1", (state) => ({ ...state, app: "com.acme" }));
		expect(readState(ctx, "U1").app).toBe("com.acme");
	});

	test("concurrent connections in one process also stay in step", () => {
		const first = setup();
		const second = connect(home ?? "");
		const seen = [1, 2, 3, 4].map((n) =>
			commitGeneration(n % 2 === 0 ? first : second, "U1", (generation) => generation)
		);
		expect(seen).toEqual([1, 2, 3, 4]);
	});

	test("last-snapshot round-trips with `flat` rebuilt from the tree; writes leave no temp files", () => {
		const ctx = setup();
		const snapshot = snapshotOf([el("window", { children: [el("button", { label: "Go", id: "go" })] })]);
		writeLastSnapshot(ctx, "U1", { generation: 2, takenAt: 7, hash: "h", snapshot });
		const back = readLastSnapshot(ctx, "U1");
		expect(back?.generation).toBe(2);
		expect(back?.snapshot.flat.map((e) => e.id)).toEqual(["0", "0.0"]);
		expect(back?.snapshot.elements).toEqual(snapshot.elements);
		expect(readdirSync(uiDir(ctx, "U1"))).toEqual(["last-snapshot.json"]);
	});

	test("a file of the wrong shape reads as empty state, not as a half-typed object", () => {
		const ctx = setup();
		writeState(ctx, "U1", { generation: 1, updatedAt: 0 });
		const state = join(uiDir(ctx, "U1"), "state.json");
		writeFileSync(state, JSON.stringify({ generation: 5, helper: { pid: "x" } }));
		expect(readState(ctx, "U1")).toEqual({ generation: 0, updatedAt: 0 });
		writeFileSync(state, JSON.stringify({ generation: "5" }));
		expect(readState(ctx, "U1")).toEqual({ generation: 0, updatedAt: 0 });
		writeFileSync(state, JSON.stringify({ generation: 5, helper: { pid: 7, socket: "/s" }, extra: true }));
		expect(readState(ctx, "U1")).toEqual({ generation: 5, helper: { pid: 7, socket: "/s" }, updatedAt: 0 });

		const snapshot = snapshotOf([el("button", { label: "Go", id: "go" })]);
		writeLastSnapshot(ctx, "U1", { generation: 2, takenAt: 7, hash: "h", snapshot });
		const file = join(uiDir(ctx, "U1"), "last-snapshot.json");
		const stored = JSON.parse(readFileSync(file, "utf8"));
		stored.snapshot.elements[0].frame = "wide";
		writeFileSync(file, JSON.stringify(stored));
		expect(readLastSnapshot(ctx, "U1")).toBeUndefined();
		stored.snapshot.elements[0].frame = snapshot.elements[0]?.frame;
		stored.snapshot.elements[0].children = [{ id: "x" }];
		writeFileSync(file, JSON.stringify(stored));
		expect(readLastSnapshot(ctx, "U1")).toBeUndefined();
	});

	test("a torn or foreign file reads as absent", () => {
		const ctx = setup();
		writeState(ctx, "U1", { generation: 1, updatedAt: 0 });
		writeFileSync(join(uiDir(ctx, "U1"), "state.json"), "{ nope");
		writeFileSync(join(uiDir(ctx, "U1"), "last-snapshot.json"), '{"generation":1}');
		expect(readState(ctx, "U1").generation).toBe(0);
		expect(readLastSnapshot(ctx, "U1")).toBeUndefined();
	});
});

describe("android dump route memory", () => {
	test("round-trips per device and ignores garbage", () => {
		const ctx = setup();
		expect(readDumpRoute(ctx, "emulator-5554")).toBeUndefined();
		writeDumpRoute(ctx, "emulator-5554", "file");
		expect(readDumpRoute(ctx, "emulator-5554")).toBe("file");
		expect(readDumpRoute(ctx, "emulator-5556")).toBeUndefined();
		writeFileSync(join(uiDir(ctx, "emulator-5554"), "android-dump-route"), "bogus\n");
		expect(readDumpRoute(ctx, "emulator-5554")).toBeUndefined();
	});
});
