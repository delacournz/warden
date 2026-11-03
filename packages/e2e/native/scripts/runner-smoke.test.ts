import { describe, expect, test } from "bun:test";
import {
	classifyXcodebuildLine,
	installedBundleIds,
	parseReadyLine,
	percentile,
	readyPort,
	runnerBundleId,
	tunnelIpFor,
} from "./runner-smoke";

const ready = {
	event: "ready",
	protocol: 1,
	version: "0.1.0",
	udid: "00008140-000A0B0C0D0E0F10",
	hid: { transport: "xcuitest" },
	ax: { default: "ax", bridge: "missing" },
	screen: { width: 440, height: 956, scale: 3 },
	backend: "ax",
	engine: "xcuitest",
	port: 8765,
};

describe("ready line", () => {
	const line = `2026-10-29 09:03:50 WARDEN_RUNNER_READY ${JSON.stringify(ready)}`;

	test("parses with readyEventSchema, wherever the prefix sits in the line", () => {
		expect(parseReadyLine(line)?.udid).toBe("00008140-000A0B0C0D0E0F10");
		expect(readyPort(line)).toBe(8765);
	});

	test("other lines and broken json are ignored", () => {
		expect(parseReadyLine("Test Case started")).toBeUndefined();
		expect(parseReadyLine("WARDEN_RUNNER_READY {nope")).toBeUndefined();
		expect(readyPort("WARDEN_RUNNER_READY {nope")).toBeUndefined();
		expect(parseReadyLine(`WARDEN_RUNNER_READY ${JSON.stringify({ event: "ready" })}`)).toBeUndefined();
	});
});

describe("tunnelIpFor", () => {
	const list = {
		result: {
			devices: [
				{
					hardwareProperties: { udid: "SIM-1", reality: "virtual" },
					connectionProperties: { tunnelIPAddress: "fd00::9" },
				},
				{
					hardwareProperties: { udid: "00008140-000A0B0C0D0E0F10", reality: "physical" },
					connectionProperties: { tunnelIPAddress: "fd5c:6079:d05b::1", tunnelState: "connected" },
				},
			],
		},
	};

	test("finds the physical device's tunnel address", () => {
		expect(tunnelIpFor(list, "00008140-000A0B0C0D0E0F10")).toBe("fd5c:6079:d05b::1");
	});

	test("never answers for a simulator or an unknown udid", () => {
		expect(tunnelIpFor(list, "SIM-1")).toBeUndefined();
		expect(tunnelIpFor(list, "nope")).toBeUndefined();
		expect(tunnelIpFor({}, "nope")).toBeUndefined();
	});
});

describe("classifyXcodebuildLine", () => {
	test("a locked phone", () => {
		expect(classifyXcodebuildLine("Unlock Chris's iPhone to Continue")).toBe("device_locked");
	});
	test("an untrusted developer profile", () => {
		expect(classifyXcodebuildLine("The request was denied. Untrusted Developer")).toBe("runner_untrusted");
	});
	test("ordinary output is not a failure", () => {
		expect(classifyXcodebuildLine("Test Case '-[RunnerTests testServe]' started.")).toBeUndefined();
	});
});

describe("bundle ids and stats", () => {
	test("the default id is the lowercased team", () => {
		expect(runnerBundleId("LN69P7N673")).toBe("nz.co.delacour.warden.runner.ln69p7n673");
		expect(installedBundleIds("a.b")).toEqual(["a.b", "a.b.uitests.xctrunner"]);
	});
	test("percentile", () => {
		expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
		expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
		expect(percentile([], 0.5)).toBeNaN();
	});
});
