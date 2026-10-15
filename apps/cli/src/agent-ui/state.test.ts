import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { bumpGeneration, readLastSnapshot, readState, uiDir, writeLastSnapshot, writeState } from "./state";

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

	test("a torn or foreign file reads as absent", () => {
		const ctx = setup();
		writeState(ctx, "U1", { generation: 1, updatedAt: 0 });
		writeFileSync(join(uiDir(ctx, "U1"), "state.json"), "{ nope");
		writeFileSync(join(uiDir(ctx, "U1"), "last-snapshot.json"), '{"generation":1}');
		expect(readState(ctx, "U1").generation).toBe(0);
		expect(readLastSnapshot(ctx, "U1")).toBeUndefined();
	});
});
