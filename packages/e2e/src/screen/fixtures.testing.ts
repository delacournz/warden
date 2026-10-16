import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUiautomatorXml } from "../driver/android/uiautomator";
import {
	REAL_DEV_LAUNCHER_DUMP,
	REAL_DEV_LAUNCHER_SCREEN,
	SYNTHETIC_FORM_DUMP,
	SYNTHETIC_FORM_SCREEN,
} from "../driver/android/uiautomator.fixture";
import { type ElementSpec, el, snapshotOf } from "../driver/driver.testing";
import type { Snapshot } from "../driver/driver.types";
import { toSnapshot } from "../driver/ios/normalize";
import { snapshotDataSchema } from "../driver/ios/simd-protocol";

const IOS_FIXTURES = join(import.meta.dir, "..", "..", "native", "ios", "Tests", "warden-simdTests", "Fixtures");

const IOS_SNAPSHOT_GOLDENS = [
	"sign-in.snapshot.golden.json",
	"sign-in.interactive.golden.json",
	"alert-bridge.snapshot.golden.json",
] as const;

export type NamedSnapshot = { name: string; snapshot: Snapshot };

/** The snapshots `warden-simd`'s Swift tests pin (what a real iOS helper answers with), run through the driver's own normaliser. */
export function iosGoldenSnapshots(): NamedSnapshot[] {
	return IOS_SNAPSHOT_GOLDENS.map((file) => {
		const data = snapshotDataSchema.parse(JSON.parse(readFileSync(join(IOS_FIXTURES, file), "utf8")));
		return { name: `ios ${file.replace(".golden.json", "")}`, snapshot: toSnapshot(data, 0) };
	});
}

function androidSnapshot(xml: string, size: { width: number; height: number }): Snapshot {
	const { elements, flat } = parseUiautomatorXml(xml, size);
	return {
		platform: "android",
		backend: "uiautomator",
		takenAt: 0,
		screen: { ...size, scale: 1 },
		elements,
		flat,
		truncated: false,
	};
}

/** The uiautomator dumps the Android parser tests use: one captured from an emulator, one synthetic RN form. */
export function androidFixtureSnapshots(): NamedSnapshot[] {
	return [
		{ name: "android dev-launcher", snapshot: androidSnapshot(REAL_DEV_LAUNCHER_DUMP, REAL_DEV_LAUNCHER_SCREEN) },
		{ name: "android synthetic-form", snapshot: androidSnapshot(SYNTHETIC_FORM_DUMP, SYNTHETIC_FORM_SCREEN) },
	];
}

function label(prefix: string, ...parts: number[]): string {
	return `${prefix} ${parts.join(".")}`;
}

/** One list row: `depth` wrapper views around a card holding a title, a price and a button. */
function row(rowNumber: number, depth: number): ElementSpec {
	let inner: ElementSpec = el("other", {
		id: `row-${rowNumber}`,
		children: [
			el("text", { label: label("Item", rowNumber) }),
			el("text", { label: label("$", rowNumber, 5) }),
			el("button", { id: `buy-${rowNumber}`, label: "Buy", hittable: true }),
		],
	});
	for (let level = 0; level < depth; level += 1) inner = el("other", { children: [inner] });
	return inner;
}

/**
 * What a React Native screen looks like to the accessibility API: a spine of `levels` wrapper views (providers,
 * navigators, scroll views) with `rows` list rows hanging off the bottom, each `rowDepth` wrappers deep.
 * The default is 23 levels deep and 298 nodes.
 */
export function deepSnapshot(options: { levels?: number; rows?: number; rowDepth?: number } = {}): Snapshot {
	const { levels = 18, rows = 40, rowDepth = 3 } = options;
	let spine: ElementSpec[] = Array.from({ length: rows }, (_, index) => row(index, rowDepth));
	for (let level = 0; level < levels; level += 1) {
		spine = [el("other", { ...(level === levels - 1 ? { id: "list" } : {}), children: spine })];
	}
	return snapshotOf(spine);
}

/** Every fixture the screen layer's cost and equivalence tests run over. */
export function allFixtureSnapshots(): NamedSnapshot[] {
	return [
		...iosGoldenSnapshots(),
		...androidFixtureSnapshots(),
		{ name: "synthetic rn-deep", snapshot: deepSnapshot() },
	];
}
