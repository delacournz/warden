import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OptOutReason, Telemetry, TelemetryStatus } from "@delacournz/cli-telemetry";
import { createWardenTelemetry } from "../telemetry/client";
import { type TestContext, testContext } from "../testing";
import { describeReason, formatStatus, runTelemetry, telemetryCommand } from "./telemetry";

const STATUS: TelemetryStatus = {
	enabled: true,
	reason: "default",
	endpoint: "https://telemetry.delacour.co.nz/v1/events",
	debug: false,
	storePath: "/home/me/.config/delacour/telemetry.json",
	persistent: true,
	machineId: null,
};

const dirs: string[] = [];
let ctx: TestContext | undefined;
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(env: Record<string, string> = {}): { telemetry: Telemetry; ctx: TestContext } {
	const dir = mkdtempSync(join(tmpdir(), "warden-telemetry-"));
	dirs.push(dir);
	const telemetry = createWardenTelemetry({
		version: "1.2.3",
		env: { NODE_ENV: "production", ...env },
		configDir: dir,
	});
	ctx = testContext([]);
	return { telemetry, ctx };
}

describe("describeReason", () => {
	test("has words for every reason, naming warden's own switches", () => {
		const reasons: OptOutReason[] = [
			"default",
			"stored-enabled",
			"do-not-track",
			"delacour-env",
			"product-env",
			"stored-disabled",
			"test-env",
			"dev-version",
		];
		for (const reason of reasons) expect(describeReason(reason).length).toBeGreaterThan(5);
		expect(describeReason("product-env")).toContain("WARDEN_TELEMETRY_DISABLED");
		expect(describeReason("stored-disabled")).toContain("warden telemetry disable");
	});
});

describe("formatStatus", () => {
	test("says on or off, why, where it goes and where the state lives", () => {
		const text = formatStatus(STATUS);
		expect(text).toContain("enabled");
		expect(text).toContain("telemetry.delacour.co.nz");
		expect(text).toContain("/home/me/.config/delacour/telemetry.json");
		expect(text).toContain("warden telemetry disable");
		expect(text).toContain("https://warden.co.nz/docs/reference/cli#telemetry");
	});

	test("offers enable when it is off", () => {
		expect(formatStatus({ ...STATUS, enabled: false, reason: "stored-disabled" })).toContain("warden telemetry enable");
	});
});

describe("runTelemetry", () => {
	test("status prints to stdout and never creates an identity", () => {
		const f = fixture();
		runTelemetry(f.ctx, "status", { json: false }, f.telemetry);
		expect(f.ctx.stdout.join("\n")).toContain("Telemetry is enabled");
		expect(f.telemetry.status().machineId).toBeNull();
	});

	test("disable then enable round-trips through the stored flag", () => {
		const f = fixture();
		runTelemetry(f.ctx, "disable", { json: false }, f.telemetry);
		expect(f.telemetry.enabled).toBe(false);
		runTelemetry(f.ctx, "enable", { json: false }, f.telemetry);
		expect(f.telemetry.enabled).toBe(true);
	});

	test("enable under an environment opt-out says it stays off", () => {
		const f = fixture({ DO_NOT_TRACK: "1" });
		runTelemetry(f.ctx, "enable", { json: false }, f.telemetry);
		expect(f.ctx.stdout.join("\n")).toContain("Telemetry stays off");
	});

	test("--json prints exactly one JSON document on stdout", () => {
		const f = fixture();
		runTelemetry(f.ctx, "status", { json: true }, f.telemetry);
		expect(f.ctx.stdout).toHaveLength(1);
		expect(JSON.parse(f.ctx.stdout[0] as string)).toMatchObject({ enabled: true, reason: "default" });
	});
});

describe("warden telemetry", () => {
	test("defaults to status and rejects an unknown action", async () => {
		ctx = testContext([], { env: { WARDEN_HOME: "/nonexistent", NODE_ENV: "test" } });
		expect(await telemetryCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("Telemetry is disabled");
		const bad = testContext(["wat"]);
		expect(await telemetryCommand.run(bad)).toBe(1);
		bad.cleanup();
	});
});
