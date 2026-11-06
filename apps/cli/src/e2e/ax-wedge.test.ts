import { describe, expect, test } from "bun:test";
import { fakeExec } from "../testing";
import { AX_WEDGE_MARKER, recoverAxWedge } from "./ax-wedge";

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
		expect(out).toMatchObject({ kind: "failed" });
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
		expect(out).toMatchObject({ kind: "failed" });
		if (out.kind === "failed") expect(out.error).toContain("Could not find service");
	});

	test("an exec that throws is a failure, never a throw", async () => {
		const out = await recoverAxWedge(async () => {
			throw new Error("spawn failed");
		}, "U1");
		expect(out).toMatchObject({ kind: "failed" });
	});
});
