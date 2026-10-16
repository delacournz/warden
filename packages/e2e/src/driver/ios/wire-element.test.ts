import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isWireElement, snapshotDataSchema, type WireElement, wireElementSchema } from "./simd-protocol";

/**
 * `isWireElement` replaces the zod parse of snapshot trees on the hot path (zod costs 6-10 ms on its first
 * call in a process, and `warden ui` is one process per command). It must accept and reject exactly what
 * `wireElementSchema` does, so the two are checked against each other on real captures and on mutations.
 */
const fixtures = join(import.meta.dir, "..", "..", "..", "native", "ios", "Tests", "warden-simdTests", "Fixtures");

function load(name: string): { elements: unknown[]; screen: unknown } {
	return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

function walk(nodes: readonly WireElement[]): WireElement[] {
	return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

const goldens = [
	"sign-in.snapshot.golden.json",
	"sign-in.interactive.golden.json",
	"alert-bridge.snapshot.golden.json",
];

const base = (): Record<string, unknown> => ({
	role: "button",
	rawType: "Button",
	frame: { x: 1, y: 2, width: 3, height: 4 },
});

describe("isWireElement agrees with wireElementSchema", () => {
	for (const name of goldens) {
		test(`every node of ${name}`, () => {
			const roots = load(name).elements as WireElement[];
			const nodes = walk(roots);
			expect(nodes.length).toBeGreaterThan(0);
			for (const node of nodes) {
				expect(wireElementSchema.safeParse(node).success).toBe(true);
				expect(isWireElement(node)).toBe(true);
			}
			for (const root of roots) expect(isWireElement(root)).toBe(true);
		});
	}

	const mutations: Array<[string, (e: Record<string, unknown>) => void]> = [
		["valid minimal", () => undefined],
		["unknown extra key", (e) => Object.assign(e, { futureField: 1 })],
		[
			"null optionals",
			(e) => Object.assign(e, { label: null, normFrame: null, traits: null, children: null, pid: null }),
		],
		[
			"every optional set",
			(e) =>
				Object.assign(e, {
					id: "0.1",
					label: "l",
					identifier: "i",
					value: "v",
					text: "t",
					placeholder: "p",
					normFrame: { x: 0, y: 0, width: 1, height: 1 },
					traits: ["button"],
					enabled: true,
					focused: false,
					hidden: false,
					selected: false,
					checked: true,
					hittable: true,
					tapPoint: { x: 1, y: 2 },
					pid: 7,
					depth: 2,
					children: [],
				}),
		],
		["unknown role", (e) => Object.assign(e, { role: "frobnicator" })],
		["missing role", (e) => delete e.role],
		["missing rawType", (e) => delete e.rawType],
		["missing frame", (e) => delete e.frame],
		["frame missing a side", (e) => Object.assign(e, { frame: { x: 1, y: 2, width: 3 } })],
		["frame with a string", (e) => Object.assign(e, { frame: { x: "1", y: 2, width: 3, height: 4 } })],
		["frame null", (e) => Object.assign(e, { frame: null })],
		["label number", (e) => Object.assign(e, { label: 3 })],
		["identifier boolean", (e) => Object.assign(e, { identifier: false })],
		["traits not an array", (e) => Object.assign(e, { traits: "button" })],
		["traits with a number", (e) => Object.assign(e, { traits: ["a", 1] })],
		["enabled string", (e) => Object.assign(e, { enabled: "yes" })],
		["checked number", (e) => Object.assign(e, { checked: 1 })],
		["tapPoint missing y", (e) => Object.assign(e, { tapPoint: { x: 1 } })],
		["pid string", (e) => Object.assign(e, { pid: "7" })],
		["depth string", (e) => Object.assign(e, { depth: "1" })],
		["normFrame bad", (e) => Object.assign(e, { normFrame: { x: 1 } })],
		["children not an array", (e) => Object.assign(e, { children: {} })],
		["child invalid", (e) => Object.assign(e, { children: [{ role: "button" }] })],
		["child valid", (e) => Object.assign(e, { children: [base()] })],
		[
			"grandchild invalid",
			(e) => Object.assign(e, { children: [{ ...base(), children: [{ ...base(), role: "x" }] }] }),
		],
		["child is null", (e) => Object.assign(e, { children: [null] })],
	];

	for (const [name, mutate] of mutations) {
		test(name, () => {
			const element = base();
			mutate(element);
			expect(isWireElement(element)).toBe(wireElementSchema.safeParse(element).success);
		});
	}

	test.each([[null], [undefined], [3], ["x"], [[]], [true]])("non-object %p", (value) => {
		expect(isWireElement(value)).toBe(false);
		expect(wireElementSchema.safeParse(value).success).toBe(false);
	});
});

describe("snapshotDataSchema uses it", () => {
	const data = (elements: unknown[]) => ({
		backend: "axbridge",
		screen: { width: 1, height: 2, scale: 3 },
		truncated: false,
		elements,
		ms: 1,
	});

	test("a golden snapshot parses and the elements pass through untouched", () => {
		const raw = load("sign-in.snapshot.golden.json");
		const parsed = snapshotDataSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.elements).toEqual(raw.elements as WireElement[]);
	});

	test("an invalid nested element fails, and the message says where and why", () => {
		const bad = { ...base(), children: [{ ...base(), children: [{ ...base(), role: "frobnicator" }] }] };
		const parsed = snapshotDataSchema.safeParse(data([base(), bad]));
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		const message = parsed.error.message;
		expect(message).toContain("elements");
		expect(message).toContain("role");
	});
});
