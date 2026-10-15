import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import {
	bumpGeneration,
	readDumpRoute,
	readLastSnapshot,
	readState,
	uiDir,
	writeDumpRoute,
	writeLastSnapshot,
	writeState,
} from "./state";

let home: string | undefined;
afterEach(() => {
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

function setup() {
	home = mkdtempSync(join(tmpdir(), "warden-ui-state-"));
	return { env: { WARDEN_HOME: home }, now: () => 42 };
}

describe("ui state", () => {
	test("lives under $WARDEN_HOME/ui/<udid>; defaults to generation 0", () => {
		const ctx = setup();
		expect(uiDir(ctx, "U1")).toBe(join(home ?? "", "ui", "U1"));
		expect(readState(ctx, "U1")).toEqual({ generation: 0, updatedAt: 0 });
		expect(readLastSnapshot(ctx, "U1")).toBeUndefined();
	});

	test("bumpGeneration persists and keeps the other fields", () => {
		const ctx = setup();
		writeState(ctx, "U1", { generation: 3, metroUrl: "http://localhost:8081", updatedAt: 0 });
		expect(bumpGeneration(ctx, "U1")).toBe(4);
		expect(readState(ctx, "U1")).toEqual({ generation: 4, metroUrl: "http://localhost:8081", updatedAt: 42 });
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
		writeFileSync(state, JSON.stringify({ generation: 5, recording: { file: 3 } }));
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
