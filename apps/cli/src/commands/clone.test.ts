import { afterEach, describe, expect, test } from "bun:test";
import { fakeHost } from "@delacour/warden-core/golden/golden.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { cloneCommand } from "./clone";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(argv: string[], host: ReturnType<typeof fakeHost>): TestContext {
	ctx = testContext(argv, { exec: host.exec });
	return ctx;
}

describe("warden clone", () => {
	test("duplicates a shut-down sim into the next free warden pool slot and records it", async () => {
		const host = fakeHost({
			sims: [
				{ udid: "SRC", name: "My setup", state: "Shutdown" },
				{ udid: "P1", name: "warden-iphone-17-1", state: "Shutdown" },
			],
		});
		const c = setup(["My setup", "--json"], host);
		expect(await cloneCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out).toMatchObject({ name: "warden-iphone-17-2", source: "SRC", profile: "iphone-17", runtime: "iOS-26-5" });
		expect(host.calls.find((cmd) => cmd[2] === "clone")).toEqual([
			"xcrun",
			"simctl",
			"clone",
			"SRC",
			"warden-iphone-17-2",
		]);
		expect(c.db.listDevices("ios").map((d) => [d.id, d.name])).toEqual([[out.udid, "warden-iphone-17-2"]]);
	});

	test("--name picks the clone's name; source by udid", async () => {
		const host = fakeHost({ sims: [{ udid: "SRC", name: "base", state: "Shutdown" }] });
		const c = setup(["SRC", "--name", "feature-x"], host);
		const ui = scriptedUi();
		c.ui = ui;
		expect(await cloneCommand.run(c)).toBe(0);
		expect(ui.events).toEqual(["spin: cloning base → feature-x…", "ok: cloned feature-x", "stop"]);
		expect(c.stdout.join("\n")).toContain("claim it with `warden claim ios --profile");
		expect(host.sims.map((s) => s.name)).toEqual(["base", "feature-x"]);
	});

	test("booted source → refuses (never shuts down someone else's device)", async () => {
		const host = fakeHost({ sims: [{ udid: "SRC", name: "base", state: "Booted" }] });
		const c = setup(["SRC"], host);
		expect(await cloneCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("booted");
		expect(host.sims).toHaveLength(1);
	});

	test("missing / extra source argument → exit 1", async () => {
		const host = fakeHost({ sims: [{ udid: "SRC", name: "base", state: "Shutdown" }] });
		const c = setup([], host);
		expect(await cloneCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("missing required argument");
		c.argv = ["SRC", "extra"];
		expect(await cloneCommand.run(c)).toBe(1);
		expect(host.sims).toHaveLength(1);
	});

	test("unknown / ambiguous source → exit 1", async () => {
		const host = fakeHost({
			sims: [
				{ udid: "A", name: "dup", state: "Shutdown" },
				{ udid: "B", name: "dup", state: "Shutdown" },
			],
		});
		expect(await cloneCommand.run(setup(["nope"], host))).toBe(1);
		ctx?.cleanup();
		const c = setup(["dup"], host);
		expect(await cloneCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("ambiguous");
	});
});
