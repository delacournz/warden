import { expect, test } from "bun:test";
import { driverFixtures, FakeDriver } from "../driver.testing";
import { driverConformance } from "./conformance";

const home = driverFixtures.snapshotOf([
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("button", { id: "go", label: "Go" }),
			driverFixtures.el("list", { children: [driverFixtures.el("cell"), driverFixtures.el("cell")] }),
		],
	}),
]);

driverConformance.run("FakeDriver", async () => new FakeDriver({ screens: [home] }));

test("driverConformance.expectSnapshotInvariants rejects a flat list that is not the tree's preorder", () => {
	const broken = { ...home, flat: [...home.flat].reverse() };
	expect(() => driverConformance.expectSnapshotInvariants(broken, "ios")).toThrow();
});

test("driverConformance.expectResultShape rejects an error without a retryable flag", () => {
	const bad = { success: false, error: { code: "E_IO", message: "x" } } as unknown as Parameters<
		typeof driverConformance.expectResultShape
	>[0];
	expect(() => driverConformance.expectResultShape(bad)).toThrow();
});

test("driverConformance.expectResultShape accepts a typed driver error", async () => {
	const d = new FakeDriver({
		screens: [home],
		onCall: (c) => (c.method === "tap" ? driverFixtures.failWith("E_IO") : undefined),
	});
	driverConformance.expectResultShape(await d.tap({ x: 1, y: 1 }));
});
