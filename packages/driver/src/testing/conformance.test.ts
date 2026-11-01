import { expect, test } from "bun:test";
import { el, failWith, fakeDriver, snapshotOf } from "../driver.testing";
import { expectResultShape, expectSnapshotInvariants, runDriverConformance } from "./conformance";

const home = snapshotOf([
	el("window", {
		children: [el("button", { id: "go", label: "Go" }), el("list", { children: [el("cell"), el("cell")] })],
	}),
]);

runDriverConformance("FakeDriver", async () => fakeDriver({ screens: [home] }));

test("expectSnapshotInvariants rejects a flat list that is not the tree's preorder", () => {
	const broken = { ...home, flat: [...home.flat].reverse() };
	expect(() => expectSnapshotInvariants(broken, "ios")).toThrow();
});

test("expectResultShape rejects an error without a retryable flag", () => {
	const bad = { success: false, error: { code: "E_IO", message: "x" } } as unknown as Parameters<
		typeof expectResultShape
	>[0];
	expect(() => expectResultShape(bad)).toThrow();
});

test("expectResultShape accepts a typed driver error", async () => {
	const d = fakeDriver({ screens: [home], onCall: (c) => (c.method === "tap" ? failWith("E_IO") : undefined) });
	expectResultShape(await d.tap({ x: 1, y: 1 }));
});
