import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-core/exec";
import { fakeExec } from "../testing";

type Handler = [prefix: string, result: Partial<ExecResult>];

import { mcpStatusProbe, parseMcpStatus, viewerProbe, xcodeChecks } from "./doctor-xcode";

/** Real `xcrun mcp-server status --format json` from Xcode 27.1 (27A9275), nothing open. */
const STATUS_27_1 = `{
  "openWorkspaces" : [

  ],
  "permission" : {
    "enabled" : true,
    "unsafeAlwaysAllowAllAgents" : false
  },
  "running" : false
}`;

const DEV = "/Applications/Xcode.app/Contents/Developer\n";
const xcode27: Handler[] = [
	["xcode-select -p", { stdout: DEV }],
	["plutil -extract ProductBuildVersion", { stdout: "27A9275\n" }],
	["plutil -extract CFBundleShortVersionString", { stdout: "27.1\n" }],
];
const xcode26: Handler[] = [
	["xcode-select -p", { stdout: DEV }],
	["plutil -extract ProductBuildVersion", { stdout: "17F113\n" }],
	["plutil -extract CFBundleShortVersionString", { stdout: "26.6\n" }],
];

describe("parseMcpStatus", () => {
	test("real Xcode 27.1 output", () => {
		expect(parseMcpStatus(STATUS_27_1)).toEqual({
			success: true,
			data: { enabled: true, running: false, allowAll: false, openWorkspaces: 0 },
		});
	});
	test("allow-all and open workspaces", () => {
		const raw = JSON.stringify({
			openWorkspaces: [{ path: "/a" }, { path: "/b" }],
			permission: { enabled: true, unsafeAlwaysAllowAllAgents: true },
			running: true,
		});
		expect(parseMcpStatus(raw)).toEqual({
			success: true,
			data: { enabled: true, running: true, allowAll: true, openWorkspaces: 2 },
		});
	});
	test("not JSON / wrong shape is an error", () => {
		expect(parseMcpStatus("usage: mcp-server").success).toBe(false);
		expect(parseMcpStatus("[]").success).toBe(false);
	});
});

describe("mcpStatusProbe", () => {
	test("Xcode 27.1: ok, states enabled / running / grants", async () => {
		const exec = fakeExec([
			["xcrun --find mcpbridge", { stdout: "/x/mcpbridge\n" }],
			["xcrun mcp-server status --format json", { stdout: STATUS_27_1 }],
		]);
		const probe = await mcpStatusProbe(exec, 27);
		expect(probe.ok).toBe(true);
		expect(probe.detail).toContain("mcpbridge");
		expect(probe.detail).toContain("headless enabled");
		expect(probe.detail).toContain("not running");
	});
	test("allow-all warns", async () => {
		const exec = fakeExec([
			["xcrun --find mcpbridge", { stdout: "/x/mcpbridge\n" }],
			[
				"xcrun mcp-server status",
				{
					stdout: JSON.stringify({
						openWorkspaces: [],
						permission: { enabled: true, unsafeAlwaysAllowAllAgents: true },
						running: true,
					}),
				},
			],
		]);
		const probe = await mcpStatusProbe(exec, 27);
		expect(probe.ok).toBe(false);
		expect(probe.detail).toContain("unsafeAlwaysAllowAllAgents");
	});
	test("Xcode 26: no mcp-server, still ok", async () => {
		const exec = fakeExec([["xcrun --find mcpbridge", { stdout: "/x/mcpbridge\n" }]]);
		const probe = await mcpStatusProbe(exec, 26);
		expect(probe).toMatchObject({ ok: true });
		expect(probe.detail).toContain("Xcode 27");
	});
	test("no mcpbridge at all is ok and says so", async () => {
		const probe = await mcpStatusProbe(fakeExec([]), 27);
		expect(probe).toMatchObject({ ok: true });
		expect(probe.detail).toContain("not available");
	});
});

describe("viewerProbe", () => {
	test("device hub", async () => {
		const exec = fakeExec([
			["pgrep -xq Simulator", { exitCode: 1 }],
			["pgrep -xq DeviceHub", { exitCode: 0 }],
		]);
		expect(await viewerProbe(exec)).toEqual({
			ok: true,
			detail: "Device Hub (Xcode 27): one window, warden does not tile or close sim windows",
		});
	});
	test("none", async () => {
		const exec = fakeExec([
			["pgrep -xq Simulator", { exitCode: 1 }],
			["pgrep -xq DeviceHub", { exitCode: 1 }],
		]);
		expect((await viewerProbe(exec)).detail).toContain("none running");
	});
});

describe("xcodeChecks", () => {
	test("27.1 host: three info checks, none fail", async () => {
		const exec = fakeExec([
			...xcode27,
			["xcrun --find mcpbridge", { stdout: "/x/mcpbridge\n" }],
			["xcrun mcp-server status", { stdout: STATUS_27_1 }],
			["pgrep -xq Simulator", { exitCode: 1 }],
			["pgrep -xq DeviceHub", { exitCode: 1 }],
		]);
		const checks = await xcodeChecks(exec, {});
		expect(checks.map((c) => c.name)).toEqual(["xcode", "xcode-mcp", "sim-viewer"]);
		expect(checks[0]?.detail).toContain("Xcode 27.1 (27A9275)");
		expect(checks.every((c) => c.status === "ok")).toBe(true);
	});
	test("26.6 host degrades gracefully", async () => {
		const exec = fakeExec([...xcode26, ["pgrep -xq Simulator", { exitCode: 0 }]]);
		const checks = await xcodeChecks(exec, {});
		expect(checks.every((c) => c.status === "ok")).toBe(true);
		expect(checks[1]?.detail).toContain("not available");
	});
	test("no Xcode selected: ok with a note (iOS is reported by the simctl check)", async () => {
		const checks = await xcodeChecks(fakeExec([]), {});
		expect(checks[0]).toMatchObject({ name: "xcode", status: "ok" });
		expect(checks[0]?.detail).toContain("no Xcode");
	});
});
