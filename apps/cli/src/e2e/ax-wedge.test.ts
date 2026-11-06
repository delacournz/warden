import { describe, expect, test } from "bun:test";
import { err, ok } from "@delacour/warden-types/result";
import { fakeExec } from "../testing";
import { AX_WEDGE_MARKER, type RebootProvider, rebootSimulator, recoverAxWedge } from "./ax-wedge";

const LOG = "xcrun simctl spawn U1 log show";
const KICK = "xcrun simctl spawn U1 launchctl kickstart -k user/foreground/com.apple.backboardd";
const wedgedLog = `Timestamp Ty Process[PID:TID]\n2026-11-06 16:15:32.585 Df SimulatorFrameworkBridge-iOS[2013:3373] (AXRuntime) AXError: ${AX_WEDGE_MARKER}\n`;

describe("recoverAxWedge", () => {
	test("a sim whose log carries the wedge marker gets backboardd restarted: recovered", async () => {
		const calls: string[][] = [];
		const out = await recoverAxWedge(
			fakeExec(
				[
					[LOG, { stdout: wedgedLog }],
					[KICK, {}],
				],
				calls
			),
			"U1"
		);
		expect(out.kind).toBe("recovered");
		expect(calls).toHaveLength(2);
		expect(calls[0]?.join(" ")).toStartWith(LOG);
		expect(calls[0]?.join(" ")).toContain(AX_WEDGE_MARKER);
		expect(calls[1]?.join(" ")).toBe(KICK);
	});

	test("no marker in the log: not wedged, backboardd left alone", async () => {
		const calls: string[][] = [];
		const out = await recoverAxWedge(fakeExec([[LOG, { stdout: "Timestamp Ty Process[PID:TID]\n" }]], calls), "U1");
		expect(out.kind).toBe("not-wedged");
		expect(calls).toHaveLength(1);
	});

	test("a log that cannot be read is a failure, and backboardd is left alone", async () => {
		const calls: string[][] = [];
		const out = await recoverAxWedge(fakeExec([[LOG, { exitCode: 1, stderr: "Invalid device state" }]], calls), "U1");
		expect(out).toMatchObject({ kind: "failed", stage: "log" });
		if (out.kind === "failed") expect(out.error).toContain("Invalid device state");
		expect(calls).toHaveLength(1);
	});

	test("a restart that fails is a failure naming why", async () => {
		const out = await recoverAxWedge(
			fakeExec([
				[LOG, { stdout: wedgedLog }],
				[KICK, { exitCode: 3, stderr: "Could not find service" }],
			]),
			"U1"
		);
		expect(out).toMatchObject({ kind: "failed", stage: "restart" });
		if (out.kind === "failed") expect(out.error).toContain("Could not find service");
	});

	test("an exec that throws is a failure, never a throw", async () => {
		const out = await recoverAxWedge(async () => {
			throw new Error("spawn failed");
		}, "U1");
		expect(out).toMatchObject({ kind: "failed" });
	});
});

describe("rebootSimulator", () => {
	/** a provider that records each step and answers from `o` */
	function provider(o: { shutdown?: string; boot?: "boot-failed" | "not-ready"; throws?: boolean } = {}) {
		const steps: string[] = [];
		const p: RebootProvider = {
			shutdown: async (id) => {
				steps.push(`shutdown ${id}`);
				if (o.throws) throw new Error("simctl gone");
				return o.shutdown === undefined ? ok(undefined) : err(o.shutdown);
			},
			bootReady: async (id, timeoutMs) => {
				steps.push(`bootReady ${id} ${timeoutMs}`);
				return o.boot === undefined ? { kind: "ready" } : { kind: o.boot, error: `${o.boot} on ${id}` };
			},
			afterReady: async (id) => {
				steps.push(`afterReady ${id}`);
			},
		};
		return { p, steps };
	}

	test("shuts the sim down, boots it and waits until ready, then redoes the post-boot steps: rebooted", async () => {
		const { p, steps } = provider();
		expect(await rebootSimulator(p, "U1", 60_000)).toEqual({ kind: "rebooted" });
		expect(steps).toEqual(["shutdown U1", "bootReady U1 60000", "afterReady U1"]);
	});

	test("a shutdown that fails stops there: failed at shutdown", async () => {
		const { p, steps } = provider({ shutdown: "Unable to shutdown device" });
		expect(await rebootSimulator(p, "U1", 60_000)).toEqual({
			kind: "failed",
			stage: "shutdown",
			error: "Unable to shutdown device",
		});
		expect(steps).toEqual(["shutdown U1"]);
	});

	test("a boot that fails, or a sim that never gets ready, names its stage", async () => {
		expect(await rebootSimulator(provider({ boot: "boot-failed" }).p, "U1", 60_000)).toEqual({
			kind: "failed",
			stage: "boot",
			error: "boot-failed on U1",
		});
		const late = provider({ boot: "not-ready" });
		expect(await rebootSimulator(late.p, "U1", 60_000)).toEqual({
			kind: "failed",
			stage: "ready",
			error: "not-ready on U1",
		});
		expect(late.steps).not.toContain("afterReady U1");
	});

	test("a provider that throws is a failure, never a throw", async () => {
		expect(await rebootSimulator(provider({ throws: true }).p, "U1", 60_000)).toEqual({
			kind: "failed",
			stage: "shutdown",
			error: "simctl gone",
		});
	});
});
