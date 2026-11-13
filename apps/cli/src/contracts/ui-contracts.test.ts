import { afterEach, describe, expect, test } from "bun:test";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { cleanupHarnesses, doc, harness, LOGIN } from "../commands/ui.testing";
import { expectContract } from "./contracts.testing";

afterEach(cleanupHarnesses);

/** The versioned `warden ui` verbs, run against the fake driver: the real `--json` parses under its schema (`fill`: ui-actions.test). */
describe("warden ui --json contracts", () => {
	test("snapshot, plain and with --settle (a diff)", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("snapshot", "-i", "--json")).toBe(0);
		expectContract("warden.ui.snapshot", doc(h.c), { name: "interactive" });
		expect(doc(h.c).schemaVersion).toBe(1);
		expect(await h.run("snapshot", "--settle", "--json")).toBe(0);
		expectContract("warden.ui.snapshot", doc(h.c), { name: "settled" });
	});

	test("snapshot -i with the on-screen keyboard folded into one element", async () => {
		const h = harness([
			snapshotOf([
				el("window", {
					children: [
						el("textfield", { label: "Email", id: "email", hittable: true, focused: true }),
						el("keyboard", {
							id: "inputView",
							frame: { x: 0, y: 573, width: 390, height: 271 },
							children: [
								el("button", { label: "q", hittable: true, frame: { x: 5, y: 597, width: 39, height: 54 } }),
								el("button", {
									label: "go",
									id: "Go",
									hittable: true,
									frame: { x: 301, y: 759, width: 89, height: 54 },
								}),
							],
						}),
					],
				}),
			]),
		]);
		expect(await h.run("snapshot", "-i", "--json")).toBe(0);
		expectContract("warden.ui.snapshot", doc(h.c), { name: "keyboard" });
		expect(doc(h.c).result.elements.at(-1)).toMatchObject({ role: "keyboard", name: "go", keys: 2 });
	});

	test("press by ref and by selector with --settle", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("snapshot", "-i", "--json")).toBe(0);
		expect(await h.run("press", "@e2", "--json")).toBe(0);
		expectContract("warden.ui.press", doc(h.c), { name: "ref" });
		expect(await h.run("press", "id=sign-in-submit", "--settle", "--verify", "--json")).toBe(0);
		expectContract("warden.ui.press", doc(h.c), { name: "selector-settled" });
		expect(await h.run("tap", "id=sign-in-submit", "--json")).toBe(0);
		expectContract("warden.ui.tap", doc(h.c), { name: "selector" });
	});

	test("press on a missing target: the failure envelope", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("press", "id=nope", "--json")).toBe(1);
		expectContract("warden.ui.press", doc(h.c), { name: "target-not-found" });
	});

	test("wait, is, get", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "id=sign-in-submit", "--json")).toBe(0);
		expectContract("warden.ui.wait", doc(h.c), { name: "visible" });
		expect(await h.run("wait", "id=nope", "--timeout", "50", "--json")).toBe(1);
		expectContract("warden.ui.wait", doc(h.c), { name: "absent" });
		expect(await h.run("is", "id=sign-in-submit", "visible", "--json")).toBe(0);
		expectContract("warden.ui.is", doc(h.c), { name: "true" });
		expect(await h.run("is", "id=nope", "visible", "--json")).toBe(1);
		expectContract("warden.ui.is", doc(h.c), { name: "false" });
		expect(await h.run("get", "id=email", "value", "--json")).toBe(0);
		expectContract("warden.ui.get", doc(h.c), { name: "value" });
		expect(await h.run("get", "id=email", "frame", "--json")).toBe(0);
		expectContract("warden.ui.get", doc(h.c), { name: "frame" });
		expect(await h.run("get", "role=button", "count", "--json")).toBe(0);
		expectContract("warden.ui.get", doc(h.c), { name: "count" });
	});

	test("open a bundle and a URL, then close", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("open", "com.example.app", "--json")).toBe(0);
		expectContract("warden.ui.open", doc(h.c), { name: "bundle" });
		expect(await h.run("open", "example://home", "--json")).toBe(0);
		expectContract("warden.ui.open", doc(h.c), { name: "url" });
		expect(await h.run("close", "--app", "--json")).toBe(0);
		expectContract("warden.ui.close", doc(h.c), { name: "app" });
	});
});
