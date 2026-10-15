import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@delacour/warden-core/store";
import { interactiveFilter, parseUiautomatorXml } from "@delacour/warden-e2e/driver/android/uiautomator";
import {
	REAL_DEV_LAUNCHER_DUMP,
	REAL_DEV_LAUNCHER_SCREEN,
} from "@delacour/warden-e2e/driver/android/uiautomator.fixture";
import type { Element, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { toSnapshot } from "@delacour/warden-e2e/driver/ios/normalize";
import { snapshotDataSchema } from "@delacour/warden-e2e/driver/ios/simd-protocol";
import { storeSnapshot } from "./snapshot";
import { preorder, readLastSnapshot } from "./state";

/**
 * `last-snapshot.json` is validated with zod when read back. These tests push the snapshots the real backends
 * produced (the golden captures `warden-simd`'s Swift tests pin, and a real uiautomator dump) through
 * `storeSnapshot` and read them back: nothing may be rejected and no field may be dropped.
 */

const goldens = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"e2e",
	"native",
	"ios",
	"Tests",
	"warden-simdTests",
	"Fixtures"
);

let home: string | undefined;
const stores: Store[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

function context() {
	home = mkdtempSync(join(tmpdir(), "warden-ui-real-"));
	const store = openStore(join(home, "warden.db"));
	stores.push(store);
	return { env: { WARDEN_HOME: home }, now: () => 1234, store: () => store };
}

function iosGolden(name: string): Snapshot {
	const data = snapshotDataSchema.parse(JSON.parse(readFileSync(join(goldens, name), "utf8")));
	return toSnapshot(data, 99);
}

function androidDump(interactiveOnly: boolean): Snapshot {
	const tree = parseUiautomatorXml(REAL_DEV_LAUNCHER_DUMP, REAL_DEV_LAUNCHER_SCREEN);
	const { elements, flat } = interactiveOnly ? interactiveFilter(tree.elements) : tree;
	return {
		platform: "android",
		backend: "uiautomator",
		takenAt: 99,
		screen: { ...REAL_DEV_LAUNCHER_SCREEN, scale: 1 },
		elements,
		flat,
		truncated: false,
	};
}

/** What the JSON file holds: `undefined` members disappear, as they do on disk. */
const onDisk = (snapshot: Snapshot): unknown => JSON.parse(JSON.stringify(snapshot));

/** Every optional field some element of `snapshot` carries, so the test can prove it covered them. */
function fieldsSeen(snapshot: Snapshot): Set<string> {
	const seen = new Set<string>();
	for (const element of snapshot.flat) {
		for (const [key, value] of Object.entries(element)) if (value !== undefined) seen.add(key);
	}
	return seen;
}

const cases: { name: string; snapshot: () => Snapshot }[] = [
	{ name: "ios sign-in (full tree)", snapshot: () => iosGolden("sign-in.snapshot.golden.json") },
	{ name: "ios sign-in (interactive)", snapshot: () => iosGolden("sign-in.interactive.golden.json") },
	{ name: "ios alert over the app", snapshot: () => iosGolden("alert-bridge.snapshot.golden.json") },
	{ name: "android dev launcher (full dump)", snapshot: () => androidDump(false) },
	{ name: "android dev launcher (interactive filter)", snapshot: () => androidDump(true) },
];

describe("last-snapshot.json against real captures", () => {
	for (const { name, snapshot } of cases) {
		test(`${name}: stored, read back and schema-parsed with no field dropped`, () => {
			const ctx = context();
			const taken = snapshot();
			expect(taken.flat.length).toBeGreaterThan(0);
			const { generation } = storeSnapshot(ctx, "U1", taken);
			const back = readLastSnapshot(ctx, "U1");
			expect(back).toBeDefined();
			expect(back?.generation).toBe(generation);
			expect(back?.snapshot.flat).toEqual(preorder(back?.snapshot.elements ?? []));
			expect(onDisk(back?.snapshot ?? taken)).toEqual(onDisk(taken));
			expect(back?.snapshot.flat.length).toBe(taken.flat.length);
		});
	}

	test("every optional element, screen and modal field survives the round-trip", () => {
		const ctx = context();
		const rect = { x: 1, y: 2, width: 3, height: 4 };
		const element: Element = {
			id: "e1",
			role: "textfield",
			rawType: "XCUIElementTypeTextField",
			label: "Email",
			identifier: "email",
			value: "a@b.c",
			text: "a@b.c",
			placeholder: "you@example.com",
			frame: rect,
			normFrame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
			traits: ["focusable"],
			enabled: true,
			focused: true,
			hidden: false,
			selected: true,
			checked: true,
			hittable: true,
			tapPoint: { x: 2.5, y: 4 },
			pid: 42,
			depth: 0,
			children: [],
		};
		const taken: Snapshot = {
			platform: "ios",
			backend: "axbridge",
			takenAt: 5,
			screen: { width: 390, height: 844, scale: 3, rotation: 90 },
			elements: [element],
			flat: [element],
			truncated: true,
			modal: { pid: 7, description: "Alert" },
		};
		storeSnapshot(ctx, "U2", taken);
		expect(onDisk(readLastSnapshot(ctx, "U2")?.snapshot ?? taken)).toEqual(onDisk(taken));
	});

	test("the real captures cover the optional element fields the schema has to keep", () => {
		const seen = new Set<string>();
		for (const { snapshot } of cases) for (const key of fieldsSeen(snapshot())) seen.add(key);
		const expected: (keyof Element)[] = ["normFrame", "traits", "enabled", "depth", "label", "identifier", "value"];
		for (const key of expected) expect(seen.has(key)).toBe(true);
		console.log(`optional fields present in the real captures: ${[...seen].sort().join(", ")}`);
	});
});
