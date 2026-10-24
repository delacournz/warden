import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { type FixtureSim, simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { createBatchCommand } from "./batch";
import { harness } from "./batch.testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const FOREIGN = { kind: "agent", sessionId: "other", cwd: "/" } as const;

const done = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

/** boot / bootstatus / shutdown flip a sim's state in the fixture */
function applySimctl(sims: FixtureSim[], cmd: readonly string[]): boolean {
	const verb = cmd[0] === "xcrun" && cmd[1] === "simctl" ? cmd[2] : undefined;
	if (verb !== "boot" && verb !== "bootstatus" && verb !== "shutdown") return false;
	const sim = sims.find((s) => s.udid === cmd[3]);
	if (sim) sim.state = verb === "shutdown" ? "Shutdown" : "Booted";
	return true;
}

/** simctl with state; `testContext`'s roomy `TEST_HOST` leaves WARDEN_CAPACITY_MAX as the only binding limit. */
function statefulSimctl(sims: FixtureSim[]): Exec {
	const rest = fakeSimctl([]);
	return async (cmd, opts) => {
		const line = cmd.join(" ");
		if (line === "xcrun simctl list devices available -j") return done(simctlDevicesJson({ "iOS-26-5": sims }));
		if (applySimctl(sims, cmd)) return done();
		if (line.startsWith("sysctl -n kern.memorystatus_vm_pressure_level")) return done("1\n");
		return rest(cmd, opts);
	};
}

/** U1-U3 are warden sims (shut down); U4 is booted and leased by someone else, so a 3-unit host has room for 2. */
function setup(env: Record<string, string> = {}) {
	const sims = [wardenSim(1), wardenSim(2), wardenSim(3), wardenSim(4, "Booted")];
	const c = testContext(["ios", "--count", "3", "--max", "4", "--jobs", "a,b,c,d,e", "--no-tui", "--", "x", "{job}"], {
		exec: statefulSimctl(sims),
	});
	c.env = { ...c.env, ...OWNER_ENV, WARDEN_CAPACITY_MAX: "3", WARDEN_CAPACITY_HEADROOM_GB: "0", ...env };
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: "U4", name: "warden-iphone-17-4" },
			owner: FOREIGN,
			ttlMs: 600_000,
		},
		c.now()
	);
	ctx = c;
	return { c, sims };
}

async function until(cond: () => boolean, ms = 6_000): Promise<void> {
	for (let waited = 0; waited < ms && !cond(); waited += 5) await Bun.sleep(5);
	expect(cond()).toBe(true);
}

/** Free the foreign sim's slot: shut it down and drop its lease. */
function freeForeign(c: TestContext, sims: FixtureSim[]) {
	const sim = sims.find((s) => s.udid === "U4");
	if (sim) sim.state = "Shutdown";
	c.db.deleteLeases(
		c.db
			.listLeases()
			.filter((l) => l.owner.kind === "agent" && l.owner.sessionId === "other")
			.map((l) => l.id)
	);
}

describe("warden batch elastic workers", () => {
	test("3 wanted, 2 fit: starts with 2; a freed slot lets the 3rd join and take jobs", async () => {
		const { c, sims } = setup();
		const h = harness({ manual: true });
		const done = createBatchCommand(h.deps).run(c);
		await until(() => h.jobs().length === 2);
		expect(new Set(h.jobs().map((j) => j.opts.env.WARDEN_UDID))).toEqual(new Set(["U1", "U2"]));
		expect(c.stderr.join("\n")).toContain("host fits 2 of 3 ios workers");
		freeForeign(c, sims);
		await until(() => h.jobs().length === 3);
		const late = h.jobs()[2];
		expect(late?.opts.env.WARDEN_UDID).toBe("U3");
		expect(late?.opts.env.WARDEN_WORKER).toBe("2");
		expect(late?.opts.env.WARDEN_JOB).toBe("c");
		for (let i = 0; i < 5; i++) {
			await until(() => h.jobs().some((j) => j.kills.length === 0 && j.opts.env.WARDEN_JOB === "abcde"[i]));
			h.jobs()
				.find((j) => j.opts.env.WARDEN_JOB === "abcde"[i])
				?.finish(0);
		}
		expect(await done).toBe(0);
		expect(c.stderr.join("\n")).toMatch(/worker 3 joined after .* \(queued\)/);
		const batch = JSON.parse(h.files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "batch.json")) ?? "{}") as {
			devices: Array<{ worker: number; udid: string; joinedAfterMs?: number }>;
		};
		expect(batch.devices.map((d) => d.udid)).toEqual(["U1", "U2", "U3"]);
		expect(batch.devices[2]?.joinedAfterMs).toBeNumber();
		expect(batch.devices[0]).not.toHaveProperty("joinedAfterMs");
		expect(c.db.listLeases()).toEqual([]);
		expect(c.db.listQueue()).toEqual([]);
	}, 15_000);

	test("the queue drains before the late claim lands: the claim is abandoned and nothing stays leased", async () => {
		const { c } = setup();
		const h = harness({ manual: true });
		const done = createBatchCommand(h.deps).run(c);
		await until(() => h.jobs().length === 2);
		for (const job of ["a", "b", "c", "d", "e"]) {
			await until(() => h.jobs().some((j) => j.opts.env.WARDEN_JOB === job));
			h.jobs()
				.find((j) => j.opts.env.WARDEN_JOB === job)
				?.finish(0);
		}
		expect(await done).toBe(0);
		expect(c.stderr.join("\n")).not.toContain("joined after");
		expect(c.db.listLeases().filter((l) => !(l.owner.kind === "agent" && l.owner.sessionId === "other"))).toEqual([]);
		expect(c.db.listQueue()).toEqual([]);
	}, 15_000);

	test("SIGINT aborts the pending claim: exit 130, every lease released", async () => {
		const { c } = setup();
		const h = harness({ manual: true });
		const done = createBatchCommand(h.deps).run(c);
		await until(() => h.jobs().length === 2);
		await until(() => c.db.listQueue().length === 1);
		h.signals.get("SIGINT")?.();
		for (const j of h.jobs()) j.finish(130);
		expect(await done).toBe(130);
		expect(c.db.listLeases().filter((l) => !(l.owner.kind === "agent" && l.owner.sessionId === "other"))).toEqual([]);
		expect(c.db.listQueue()).toEqual([]);
	}, 15_000);

	test("WARDEN_CAPACITY=off: all workers claimed up front, no elastic note", async () => {
		const { c } = setup({ WARDEN_CAPACITY: "off" });
		const h = harness();
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		expect(new Set(h.jobs().map((j) => j.opts.env.WARDEN_UDID)).size).toBe(3);
		expect(c.stderr.join("\n")).not.toContain("host fits");
		expect(c.db.listLeases().filter((l) => !(l.owner.kind === "agent" && l.owner.sessionId === "other"))).toEqual([]);
	});
});
