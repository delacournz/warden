import { describe, expect, test } from "bun:test";
import { driverFixtures } from "./driver.testing";
import { refResolver } from "./refs";

const snapshot = driverFixtures.snapshotOf([
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("button", { id: "login", label: "Log in" }),
			driverFixtures.el("list", { children: [driverFixtures.el("cell", { label: "Row" })] }),
		],
	}),
	driverFixtures.el("keyboard"),
]);

describe("refResolver.assign", () => {
	test("numbers @e1… in preorder over flat", () => {
		const table = refResolver.assign(snapshot, 1);
		expect([...table.byRef.keys()]).toEqual(["@e1", "@e2", "@e3", "@e4", "@e5"]);
		expect(table.byRef.get("@e1")?.role).toBe("window");
		expect(table.byRef.get("@e2")?.identifier).toBe("login");
		expect(table.byRef.get("@e4")?.label).toBe("Row");
		expect(table.byRef.get("@e5")?.role).toBe("keyboard");
	});

	test("byId maps element ids back to refs", () => {
		const table = refResolver.assign(snapshot, 1);
		const cell = snapshot.flat[3];
		expect(cell && table.byId.get(cell.id)).toBe("@e4");
		expect(cell && refResolver.refFor(table, cell)).toBe("@e4");
		expect(refResolver.refFor(table, { id: "nope" })).toBeUndefined();
	});

	test("empty snapshot has no refs", () => {
		expect(refResolver.assign(driverFixtures.snapshotOf([]), 3).byRef.size).toBe(0);
	});
});

describe("refResolver.resolve", () => {
	const table = refResolver.assign(snapshot, 4);

	test("resolves a ref of the current generation", () => {
		const result = refResolver.resolve(table, "@e2", 4);
		expect(result.success && result.data.identifier).toBe("login");
	});

	test("E_STALE_REF when generations differ (retryable)", () => {
		const result = refResolver.resolve(table, "@e2", 5);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("E_STALE_REF");
		expect(result.error.retryable).toBe(true);
		expect(result.error.detail).toEqual({ ref: "@e2", refGeneration: 4, currentGeneration: 5 });
	});

	test("stale wins over unknown ref", () => {
		const result = refResolver.resolve(table, "@e99", 5);
		expect(!result.success && result.error.code).toBe("E_STALE_REF");
	});

	test("E_NO_ELEMENT for unknown or malformed refs", () => {
		const unknown = refResolver.resolve(table, "@e99", 4);
		expect(!unknown.success && unknown.error.code).toBe("E_NO_ELEMENT");
		const malformed = refResolver.resolve(table, "login", 4);
		expect(!malformed.success && malformed.error.message).toContain("malformed");
	});
});

describe("refResolver.isRef", () => {
	test("matches only @eN", () => {
		expect(refResolver.isRef("@e1")).toBe(true);
		expect(refResolver.isRef("@e12")).toBe(true);
		expect(refResolver.isRef("@e0")).toBe(false);
		expect(refResolver.isRef("e1")).toBe(false);
		expect(refResolver.isRef("@e1x")).toBe(false);
	});
});
