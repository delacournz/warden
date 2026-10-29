import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeElements } from "../../src/driver/ios/normalize";
import {
	alertButtonsDataSchema,
	elementAtPointDataSchema,
	healthDataSchema,
	isWireElement,
	launchDataSchema,
	parseLine,
	readyEventSchema,
	type SnapshotData,
	snapshotDataSchema,
	terminateDataSchema,
	type WireElement,
	wireElementSchema,
} from "../../src/driver/ios/simd-protocol";

/**
 * The goldens in `ios/Tests/warden-simdTests/Fixtures` are what `warden-simd`'s Swift tests pin the AX ops to
 * (`WARDEN_SIMD_UPDATE_GOLDEN=1 swift test` regenerates them). This test parses the very same files with the zod
 * schemas the TS driver validates real helper output with, so a Swift model that drifts from the TS `Element`
 * shape fails here.
 */
const fixtures = join(import.meta.dir, "..", "ios", "Tests", "warden-simdTests", "Fixtures");

function load(name: string, directory: string = fixtures): unknown {
	return JSON.parse(readFileSync(join(directory, name), "utf8"));
}

/** zod objects strip unknown keys, so a parse that differs from the input means the helper sent a field the schema lacks. */
function expectNoStrippedKeys(raw: unknown, parsed: unknown): void {
	expect(parsed).toEqual(raw);
}

function walk(elements: readonly WireElement[]): WireElement[] {
	return elements.flatMap((element) => [element, ...walk(element.children ?? [])]);
}

const snapshotGoldens = [
	"sign-in.snapshot.golden.json",
	"sign-in.interactive.golden.json",
	"alert-bridge.snapshot.golden.json",
];

describe("snapshot goldens", () => {
	for (const name of snapshotGoldens) {
		test(`${name} parses with snapshotDataSchema and carries nothing the schema drops`, () => {
			const raw = load(name);
			const parsed = snapshotDataSchema.safeParse(raw);
			expect(parsed.success).toBe(true);
			if (!parsed.success) return;
			expectNoStrippedKeys(raw, parsed.data);
			expect(parsed.data.elements.length).toBeGreaterThan(0);
		});

		/**
		 * `snapshotDataSchema` validates elements with the hand-written `isWireElement` (no zod stripping), so the
		 * drift guard for fields the schema lacks runs on `wireElementSchema` itself.
		 */
		test(`${name} elements carry nothing wireElementSchema drops, and isWireElement agrees`, () => {
			const raw = load(name) as { elements: unknown[] };
			for (const element of raw.elements) {
				expectNoStrippedKeys(element, wireElementSchema.parse(element));
				expect(isWireElement(element)).toBe(true);
			}
		});

		test(`${name} elements are complete: preorder-path ids, depth, normFrame, traits, enabled`, () => {
			const data = snapshotDataSchema.parse(load(name)) as SnapshotData;
			const { screen } = data;
			const visit = (nodes: readonly WireElement[], depth: number): void => {
				for (const node of nodes) {
					expect(node.id).toMatch(/^\d+(\.\d+)*$/);
					expect(node.id?.split(".").length).toBe((node.depth ?? -1) + 1);
					expect(node.depth).toBe(depth);
					expect(node.traits).toBeArray();
					expect(typeof node.enabled).toBe("boolean");
					expect(node.normFrame?.x).toBeCloseTo(node.frame.x / screen.width, 9);
					expect(node.normFrame?.height).toBeCloseTo(node.frame.height / screen.height, 9);
					visit(node.children ?? [], depth + 1);
				}
			};
			visit(data.elements, 0);
		});

		test(`${name} survives the driver's normalizer unchanged`, () => {
			const data = snapshotDataSchema.parse(load(name));
			const { flat } = normalizeElements(data.elements, data.screen);
			const wireIds = walk(data.elements).map((node) => node.id ?? "");
			expect(flat.map((element) => element.id)).toEqual(wireIds);
		});
	}

	test("the helper's testIDs are plain identifiers, not labels", () => {
		const data = snapshotDataSchema.parse(load("sign-in.interactive.golden.json"));
		const identifiers = walk(data.elements)
			.map((node) => node.identifier)
			.filter((id): id is string => id !== undefined);
		expect(identifiers).toEqual(
			expect.arrayContaining(["sign-in-screen", "sign-in-email", "sign-in-password", "sign-in-submit"])
		);
	});

	test("the system alert is reported as a modal with its buttons reachable", () => {
		const data = snapshotDataSchema.parse(load("alert-bridge.snapshot.golden.json"));
		expect(data.modal?.description).toBe("Allow “Maps” to use your location?");
		expect(data.modal?.pid).toBeNumber();
		const labels = walk(data.elements)
			.filter((node) => node.role === "button")
			.map((node) => node.label);
		expect(labels).toEqual(expect.arrayContaining(["Allow Once", "Allow While Using App", "Don’t Allow"]));
	});

	test("a response line carrying a golden snapshot passes the client's line parser", () => {
		const line = JSON.stringify({ id: "1", ok: true, data: load("sign-in.interactive.golden.json") });
		const parsed = parseLine(line);
		expect(parsed.success).toBe(true);
	});
});

describe("alertButtons goldens", () => {
	for (const name of ["alert-host.alert.golden.json", "alert-bridge.alert.golden.json"]) {
		test(`${name} parses with alertButtonsDataSchema`, () => {
			const raw = load(name);
			const parsed = alertButtonsDataSchema.safeParse(raw);
			expect(parsed.success).toBe(true);
			if (!parsed.success || parsed.data === null) throw new Error("expected an alert");
			expectNoStrippedKeys(raw, parsed.data);
			expect(parsed.data.title).toBe("Allow “Maps” to use your location?");
			expect(parsed.data.buttons.map((button) => button.label)).toEqual([
				"Allow Once",
				"Allow While Using App",
				"Don’t Allow",
			]);
			for (const button of parsed.data.buttons) {
				expect(button.role).toBe("button");
				expect(button.tapPoint).toBeDefined();
				expect(button.frame.width).toBeGreaterThan(0);
			}
		});
	}

	test("null means no alert", () => {
		expect(alertButtonsDataSchema.parse(null)).toBeNull();
	});
});

describe("elementAtPoint capture", () => {
	test("parses with elementAtPointDataSchema and carries nothing the schema drops", () => {
		const raw = load("hit.element.capture.json");
		const parsed = elementAtPointDataSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expectNoStrippedKeys(raw, parsed.data);
		expect(parsed.data?.identifier).toBe("sign-in-email");
		expect(parsed.data?.hittable).toBe(true);
	});

	test("null means nothing under the point", () => {
		expect(elementAtPointDataSchema.parse(null)).toBeNull();
	});
});

describe("app lifecycle reply goldens", () => {
	test("launch.reply.golden.json parses with launchDataSchema", () => {
		const raw = load("launch.reply.golden.json");
		const parsed = launchDataSchema.parse(raw);
		expect(parsed.pid).toBe(4242);
		expectNoStrippedKeys(raw, parsed);
	});

	test("terminate.reply.golden.json parses with terminateDataSchema", () => {
		const raw = load("terminate.reply.golden.json");
		const parsed = terminateDataSchema.parse(raw);
		expect(parsed.terminated).toBe(true);
		expectNoStrippedKeys(raw, parsed);
	});
});

/**
 * `warden-runner` (XCUITest, real devices) answers with the same wire shapes as `warden-simd`. Its goldens come from
 * `ios-runner/RunnerCore` (`WARDEN_RUNNER_UPDATE_GOLDEN=1 swift test --package-path native/ios-runner/RunnerCore`).
 */
const runnerFixtures = join(import.meta.dir, "..", "ios-runner", "RunnerCore", "Tests", "RunnerCoreTests", "Fixtures");

function loadRunner(name: string): unknown {
	return JSON.parse(readFileSync(join(runnerFixtures, name), "utf8"));
}

const runnerSnapshotGoldens = [
	"sign-in.snapshot.golden.json",
	"sign-in.interactive.golden.json",
	"sign-in-landscape-left.snapshot.golden.json",
];

describe("warden-runner snapshot goldens", () => {
	for (const name of runnerSnapshotGoldens) {
		test(`${name} parses with snapshotDataSchema and carries nothing the schema drops`, () => {
			const raw = load(name, runnerFixtures);
			const parsed = snapshotDataSchema.safeParse(raw);
			expect(parsed.success).toBe(true);
			if (!parsed.success) return;
			expectNoStrippedKeys(raw, parsed.data);
			expect(parsed.data.backend).toBe("ax");
			expect(parsed.data.elements.length).toBeGreaterThan(0);
		});

		test(`${name} elements carry nothing wireElementSchema drops, and isWireElement agrees`, () => {
			const raw = load(name, runnerFixtures) as { elements: unknown[] };
			for (const element of raw.elements) {
				expectNoStrippedKeys(element, wireElementSchema.parse(element));
				expect(isWireElement(element)).toBe(true);
			}
		});

		test(`${name} elements are complete and survive the driver's normalizer`, () => {
			const data = snapshotDataSchema.parse(load(name, runnerFixtures)) as SnapshotData;
			const { screen } = data;
			const visit = (nodes: readonly WireElement[], depth: number): void => {
				for (const node of nodes) {
					expect(node.id).toMatch(/^\d+(\.\d+)*$/);
					expect(node.id?.split(".").length).toBe((node.depth ?? -1) + 1);
					expect(node.depth).toBe(depth);
					expect(node.traits).toBeArray();
					expect(typeof node.enabled).toBe("boolean");
					expect(node.normFrame?.x).toBeCloseTo(node.frame.x / screen.width, 9);
					visit(node.children ?? [], depth + 1);
				}
			};
			visit(data.elements, 0);
			const { flat } = normalizeElements(data.elements, data.screen);
			expect(flat.map((element) => element.id)).toEqual(walk(data.elements).map((node) => node.id ?? ""));
		});
	}

	test("landscape input is reported in portrait-up points: the same document as portrait", () => {
		expect(loadRunner("sign-in-landscape-left.snapshot.golden.json")).toEqual(
			loadRunner("sign-in.snapshot.golden.json")
		);
		const data = snapshotDataSchema.parse(loadRunner("sign-in-landscape-left.snapshot.golden.json"));
		expect(data.screen).toEqual({ width: 440, height: 956, scale: 3 });
		const email = walk(data.elements).find((node) => node.identifier === "sign-in-email");
		expect(email?.frame).toEqual({ x: 24, y: 200, width: 392, height: 48 });
	});

	test("testIDs are plain identifiers and the keyboard keys stay out of interactiveOnly", () => {
		const data = snapshotDataSchema.parse(loadRunner("sign-in.interactive.golden.json"));
		const nodes = walk(data.elements);
		expect(nodes.map((node) => node.identifier).filter((id): id is string => id !== undefined)).toEqual(
			expect.arrayContaining(["sign-in-email", "sign-in-password", "sign-in-submit"])
		);
		expect(nodes.some((node) => node.rawType === "Key")).toBe(false);
	});

	test("a response line carrying a runner snapshot passes the client's line parser", () => {
		const line = JSON.stringify({ id: "1", ok: true, data: loadRunner("sign-in.interactive.golden.json") });
		expect(parseLine(line).success).toBe(true);
	});
});

describe("warden-runner alertButtons golden", () => {
	test("parses with alertButtonsDataSchema and each button is tappable", () => {
		const raw = loadRunner("alert.alert.golden.json");
		const parsed = alertButtonsDataSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (!parsed.success || parsed.data === null) throw new Error("expected an alert");
		expectNoStrippedKeys(raw, parsed.data);
		expect(parsed.data.title).toBe("Allow “Maps” to use your location?");
		expect(parsed.data.buttons.map((button) => button.label)).toEqual([
			"Allow Once",
			"Allow While Using App",
			"Don’t Allow",
		]);
		for (const button of parsed.data.buttons) {
			expect(button.role).toBe("button");
			expect(button.tapPoint).toBeDefined();
			expect(button.frame.width).toBeGreaterThan(0);
		}
	});
});

describe("warden-runner handshake goldens", () => {
	test("the ready event satisfies readyEventSchema and names the engine", () => {
		const raw = loadRunner("ready.event.golden.json") as Record<string, unknown>;
		const parsed = readyEventSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		expect(raw.backend).toBe("ax");
		expect(raw.engine).toBe("xcuitest");
		expect(parseLine(JSON.stringify(raw)).success).toBe(true);
	});

	test("health parses with healthDataSchema", () => {
		const parsed = healthDataSchema.safeParse(loadRunner("health.golden.json"));
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.ax.bridge).toBe("missing");
	});
});
