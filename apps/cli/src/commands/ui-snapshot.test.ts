import { afterEach, describe, expect, test } from "bun:test";
import type { Snapshot } from "@delacour/warden-driver/driver.types";
import { driverFixtures, type ElementSpec, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { resultFactory } from "@delacour/warden-types/result";
import { defaultUiDeps, type UiDeps } from "../agent-ui/driver";
import { uiStatePersistence } from "../agent-ui/state";
import { OWNER_ENV } from "../simctl.testing";
import { cliTesting, type TestContext } from "../testing";
import { UiCommand, uiCommand } from "./ui";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

const LOGIN: ElementSpec[] = [
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("text", { label: "Welcome" }),
			driverFixtures.el("textfield", { label: "Email", id: "email", value: "a@b.co" }),
			driverFixtures.el("button", { label: "Sign in", id: "sign-in-submit", hittable: true }),
			driverFixtures.el("image", { label: "logo" }),
		],
	}),
];

type Harness = {
	c: TestContext;
	clock: { t: number };
	driver: FakeDriver;
	run: (...argv: string[]) => Promise<number>;
};

/** A context with a leased device, a fake clock that `sleep` advances, and a fake driver over `screens`. */
function harness(screens: Snapshot[] | (() => Snapshot)): Harness {
	const clock = { t: 1_000_000 };
	const driver = new FakeDriver({ screens });
	const deps: UiDeps = {
		driver: async () => resultFactory.ok(driver),
		sleep: async (ms) => {
			clock.t += ms;
		},
	};
	const c = cliTesting.testContext([], { now: () => clock.t });
	ctx = c;
	c.env = { ...c.env, ...OWNER_ENV };
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
			owner: { kind: "agent", sessionId: "me", cwd: "/w" },
			ttlMs: 10 * 60 * 60_000,
		},
		clock.t
	);
	const command = new UiCommand(deps).definition();
	return {
		c,
		clock,
		driver,
		run: (...argv) => {
			c.argv = [...argv, "--udid", UDID];
			c.stdout.length = 0;
			c.stderr.length = 0;
			return command.run(c);
		},
	};
}

const doc = (c: TestContext) => {
	expect(c.stdout).toHaveLength(1);
	return JSON.parse(c.stdout[0] ?? "");
};

describe("warden ui snapshot", () => {
	test("golden: full tree, indented, refs over the whole tree", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		expect(await h.run("snapshot")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe(
			[
				"generation 1 · axbridge · 390×844@3x · 5 elements",
				"@e1 [other] enabled (0,0 390×44)",
				'  @e2 [text] "Welcome" enabled (0,50 390×44)',
				'  @e3 [textbox] "Email" id=email value="a@b.co" enabled (0,100 390×44)',
				'  @e4 [button] "Sign in" id=sign-in-submit enabled hittable (0,150 390×44)',
				'  @e5 [image] "logo" enabled (0,200 390×44)',
			].join("\n")
		);
	});

	test("golden: -i keeps interactive elements and testIDs, same refs", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		expect(await h.run("snapshot", "-i")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe(
			[
				"generation 1 · axbridge · 390×844@3x · 2 of 5 elements",
				'@e3 [textbox] "Email" id=email value="a@b.co" enabled (0,100 390×44)',
				'@e4 [button] "Sign in" id=sign-in-submit enabled hittable (0,150 390×44)',
			].join("\n")
		);
	});

	test("--depth limits levels without renumbering refs", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		expect(await h.run("snapshot", "--depth", "1")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe(
			["generation 1 · axbridge · 390×844@3x · 1 elements", "@e1 [other] enabled (0,0 390×44)"].join("\n")
		);
	});

	test("backend-truncated trees say so in the header", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN, { truncated: true })]);
		await h.run("snapshot");
		expect(h.c.stdout[0]?.split("\n")[0]).toBe("generation 1 · axbridge · 390×844@3x · 5 elements, truncated");
	});

	test("--json: one document with generation and result.elements (same set as the lines)", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		expect(await h.run("snapshot", "-i", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out).toMatchObject({ ok: true, command: "snapshot", generation: 1, device: { udid: UDID } });
		expect(out.result.elements).toEqual([
			{
				ref: "@e3",
				role: "textbox",
				name: "Email",
				id: "email",
				value: "a@b.co",
				enabled: true,
				frame: { x: 0, y: 100, width: 390, height: 44 },
			},
			{
				ref: "@e4",
				role: "button",
				name: "Sign in",
				id: "sign-in-submit",
				enabled: true,
				hittable: true,
				frame: { x: 0, y: 150, width: 390, height: 44 },
			},
		]);
		expect(out.result).toMatchObject({ total: 5, shown: 2, omitted: 0, backend: "axbridge" });

		await h.run("snapshot", "--json");
		expect(doc(h.c).result.elements).toHaveLength(5);
	});

	test("the default cap prints `… N more (use --all)`; --all lifts it", async () => {
		const rows = Array.from({ length: 205 }, (_, i) => driverFixtures.el("button", { label: `b${i}` }));
		const h = harness([driverFixtures.snapshotOf(rows)]);
		await h.run("snapshot");
		const capped = h.c.stdout.join("\n").split("\n");
		expect(capped).toHaveLength(1 + 200 + 1);
		expect(capped.at(-1)).toBe("… 5 more (use --all)");
		await h.run("snapshot", "--all");
		expect(h.c.stdout.join("\n").split("\n")).toHaveLength(1 + 205);
	});

	test("stores last-snapshot.json + state.json under $WARDEN_HOME/ui/<udid>", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		await h.run("snapshot");
		const stored = uiStatePersistence.readLastSnapshot(h.c, UDID);
		expect(stored).toMatchObject({ generation: 1, takenAt: h.clock.t });
		expect(stored?.snapshot.flat.map((e) => e.id)).toEqual(["0", "0.0", "0.1", "0.2", "0.3"]);
		expect(uiStatePersistence.readState(h.c, UDID)).toMatchObject({ generation: 1 });
	});

	test("--settle: waits for two equal hashes >= 250 ms apart, then prints a +/-/= diff vs the stored snapshot", async () => {
		const before = driverFixtures.snapshotOf([
			driverFixtures.el("text", { label: "Loading" }),
			driverFixtures.el("button", { label: "Keep", id: "keep" }),
		]);
		const loaded = driverFixtures.snapshotOf([
			driverFixtures.el("text", { label: "Loaded" }),
			driverFixtures.el("button", { label: "Keep", id: "keep" }),
		]);
		const h = harness([before]);
		await h.run("snapshot");
		h.driver.set(loaded);
		h.clock.t += 5000;
		expect(await h.run("snapshot", "--settle")).toBe(0);
		const text = h.c.stdout.join("\n");
		expect(text).toContain("generation 2");
		expect(text).toContain("# settled after");
		expect(text).toContain("# diff vs generation 1");
		expect(text).toContain('- [text] "Loading" enabled (0,0 390×44)');
		expect(text).toContain('+ @e1 [text] "Loaded" enabled (0,0 390×44)');
		expect(text).toContain("= 1 unchanged");
		expect(h.driver.callsOf("snapshot").length).toBeGreaterThanOrEqual(2 + 1);
	});

	test("--settle on a screen that keeps changing gives up at the budget with a warning", async () => {
		let n = 0;
		const h = harness(() => driverFixtures.snapshotOf([driverFixtures.el("text", { label: `tick ${n++}` })]));
		expect(await h.run("snapshot", "--settle", "600", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.result.settle.quiet).toBe(false);
		expect(out.warnings).toEqual(["screen did not settle within the budget"]);
		expect(out.result.diff).toBeNull();
	});

	test("--settle/--depth must be positive integers", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		expect(await h.run("snapshot", "--depth", "0", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(await h.run("snapshot", "--settle", "abc", "--json")).toBe(1);
	});

	test("generation bumps only on snapshot, snapshot --settle and find", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		await h.run("status");
		expect(uiStatePersistence.readState(h.c, UDID).generation).toBe(0);
		await h.run("snapshot");
		expect(uiStatePersistence.readState(h.c, UDID).generation).toBe(1);
		await h.run("snapshot", "-i");
		expect(uiStatePersistence.readState(h.c, UDID).generation).toBe(2);
		await h.run("snapshot", "--settle", "500");
		expect(uiStatePersistence.readState(h.c, UDID).generation).toBe(3);
		await h.run("find", "id=email");
		expect(uiStatePersistence.readState(h.c, UDID).generation).toBe(4);
		await h.run("status");
		await h.run("snapshot", "--depth", "x");
		expect(uiStatePersistence.readState(h.c, UDID).generation).toBe(4);
	});

	test("no driver in this build: engine_unavailable, exit 3, one JSON document", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		h.c.argv = ["snapshot", "--udid", UDID, "--json"];
		expect(await uiCommand.run(h.c)).toBe(3);
		expect(doc(h.c)).toMatchObject({ ok: false, error: { code: "engine_unavailable" }, device: { udid: UDID } });
		expect(defaultUiDeps.driver).toBeDefined();
	});

	test("the driver is closed when the command ends", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		await h.run("snapshot");
		expect(h.driver.closed).toBe(true);
	});

	test("a driver failure maps to a ui error (E_AX_UNAVAILABLE → exit 3)", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		const failing = new FakeDriver({
			screens: [driverFixtures.snapshotOf(LOGIN)],
			onCall: (call) =>
				call.method === "snapshot"
					? { error: { code: "E_AX_UNAVAILABLE", message: "no ax", retryable: false } }
					: undefined,
		});
		const command = new UiCommand({
			driver: async () => resultFactory.ok(failing),
			sleep: async () => undefined,
		}).definition();
		h.c.argv = ["snapshot", "--udid", UDID, "--json"];
		expect(await command.run(h.c)).toBe(3);
		expect(doc(h.c).error.code).toBe("engine_unavailable");
	});
});

describe("warden ui find", () => {
	const SCREEN = driverFixtures.snapshotOf([
		driverFixtures.el("button", { label: "Save", id: "save" }),
		driverFixtures.el("button", { label: "Save as…", id: "save-as" }),
		driverFixtures.el("text", { label: "Saved 2 min ago" }),
	]);

	test("prints matching lines with refs; honours nth=", async () => {
		const h = harness([SCREEN]);
		expect(await h.run("find", "role=button", "label=save")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe(
			[
				"generation 1 · 2 matches",
				'@e1 [button] "Save" id=save enabled (0,0 390×44)',
				'@e2 [button] "Save as…" id=save-as enabled (0,50 390×44)',
			].join("\n")
		);
		await h.run("find", "role=button", "nth=1", "--json");
		const out = doc(h.c);
		expect(out).toMatchObject({ generation: 2, result: { count: 1 } });
		expect(out.result.elements[0]).toMatchObject({ ref: "@e2", id: "save-as" });
	});

	test("no match is exit 0 with count 0; a bad selector is a usage error", async () => {
		const h = harness([SCREEN]);
		expect(await h.run("find", "id=nope", "--json")).toBe(0);
		expect(doc(h.c).result).toEqual({ count: 0, elements: [] });
		expect(await h.run("find", "bogus", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});

	test("find stores the snapshot its refs belong to", async () => {
		const h = harness([SCREEN]);
		await h.run("find", "id=save-as");
		expect(uiStatePersistence.readLastSnapshot(h.c, UDID)?.generation).toBe(1);
	});
});
