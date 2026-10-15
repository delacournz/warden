import { describe, expect, test } from "bun:test";
import { el, snapshotOf } from "./driver.testing";
import { assignRefs, isRef, refFor, resolveRef } from "./refs";

const snapshot = snapshotOf([
	el("window", {
		children: [
			el("button", { id: "login", label: "Log in" }),
			el("list", { children: [el("cell", { label: "Row" })] }),
		],
	}),
	el("keyboard"),
]);

describe("assignRefs", () => {
	test("numbers @e1… in preorder over flat", () => {
		const table = assignRefs(snapshot, 1);
		expect([...table.byRef.keys()]).toEqual(["@e1", "@e2", "@e3", "@e4", "@e5"]);
		expect(table.byRef.get("@e1")?.role).toBe("window");
		expect(table.byRef.get("@e2")?.identifier).toBe("login");
		expect(table.byRef.get("@e4")?.label).toBe("Row");
		expect(table.byRef.get("@e5")?.role).toBe("keyboard");
	});

	test("byId maps element ids back to refs", () => {
		const table = assignRefs(snapshot, 1);
		const cell = snapshot.flat[3];
		expect(cell && table.byId.get(cell.id)).toBe("@e4");
		expect(cell && refFor(table, cell)).toBe("@e4");
		expect(refFor(table, { id: "nope" })).toBeUndefined();
	});

	test("empty snapshot has no refs", () => {
		expect(assignRefs(snapshotOf([]), 3).byRef.size).toBe(0);
	});
});

describe("resolveRef", () => {
	const table = assignRefs(snapshot, 4);

	test("resolves a ref of the current generation", () => {
		const result = resolveRef(table, "@e2", 4);
		expect(result.success && result.data.identifier).toBe("login");
	});

	test("E_STALE_REF when generations differ (retryable)", () => {
		const result = resolveRef(table, "@e2", 5);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("E_STALE_REF");
		expect(result.error.retryable).toBe(true);
		expect(result.error.detail).toEqual({ ref: "@e2", refGeneration: 4, currentGeneration: 5 });
	});

	test("stale wins over unknown ref", () => {
		const result = resolveRef(table, "@e99", 5);
		expect(!result.success && result.error.code).toBe("E_STALE_REF");
	});

	test("E_NO_ELEMENT for unknown or malformed refs", () => {
		const unknown = resolveRef(table, "@e99", 4);
		expect(!unknown.success && unknown.error.code).toBe("E_NO_ELEMENT");
		const malformed = resolveRef(table, "login", 4);
		expect(!malformed.success && malformed.error.message).toContain("malformed");
	});
});

describe("isRef", () => {
	test("matches only @eN", () => {
		expect(isRef("@e1")).toBe(true);
		expect(isRef("@e12")).toBe(true);
		expect(isRef("@e0")).toBe(false);
		expect(isRef("e1")).toBe(false);
		expect(isRef("@e1x")).toBe(false);
	});
});
