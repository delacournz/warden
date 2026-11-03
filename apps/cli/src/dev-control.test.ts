import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import {
	callDevControl,
	controlSocketPath,
	type DevFeatures,
	parseDevControlRequest,
	parseDevFeatures,
	serveDevControl,
} from "./dev-control";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "wdc-"));
	dirs.push(dir);
	return dir;
};

describe("parseDevFeatures", () => {
	test("names, `perf` as the HUD and `all`", () => {
		expect(parseDevFeatures(["hud"])).toEqual(ok(["hud"]));
		expect(parseDevFeatures(["perf", "devtools"])).toEqual(ok(["hud", "devtools"]));
		expect(parseDevFeatures(["all"])).toEqual(ok(["hud", "devtools"]));
		expect(parseDevFeatures(["hud,devtools", "hud"])).toEqual(ok(["hud", "devtools"]));
	});

	test("an unknown name is an error naming the valid ones", () => {
		const parsed = parseDevFeatures(["cpu"]);
		expect(parsed.success).toBe(false);
		if (!parsed.success) expect(parsed.error).toContain("hud | perf | devtools | all");
	});
});

describe("parseDevControlRequest", () => {
	test("set and status", () => {
		expect(parseDevControlRequest({ op: "set", feature: "devtools", on: true })).toEqual({
			op: "set",
			feature: "devtools",
			on: true,
		});
		expect(parseDevControlRequest({ op: "status" })).toEqual({ op: "status" });
	});

	test("anything else is undefined", () => {
		expect(parseDevControlRequest({ op: "set", feature: "cpu", on: true })).toBeUndefined();
		expect(parseDevControlRequest({ op: "set", feature: "hud" })).toBeUndefined();
		expect(parseDevControlRequest("status")).toBeUndefined();
	});
});

describe("controlSocketPath", () => {
	test("<logDir>/control.sock, else a short temp path", () => {
		expect(controlSocketPath("/w/dev/abc")).toBe("/w/dev/abc/control.sock");
		const long = `/${"x".repeat(120)}`;
		expect(controlSocketPath(long, () => "/t")).toMatch(/^\/t\/warden-ctl-[0-9a-f]{12}\.sock$/);
	});
});

describe("serveDevControl + callDevControl", () => {
	test("a set is answered with the features after it", async () => {
		const path = join(tempDir(), "control.sock");
		const features: DevFeatures = { hud: false, devtools: false };
		const served = await serveDevControl(path, async (request) => {
			if (request.op === "set") features[request.feature] = request.on;
			return { ok: true, features: { ...features } };
		});
		expect(served.success).toBe(true);
		if (!served.success) return;
		try {
			const set = await callDevControl(path, { op: "set", feature: "devtools", on: true });
			expect(set).toEqual(ok({ ok: true, features: { hud: false, devtools: true } }));
			const status = await callDevControl(path, { op: "status" });
			expect(status).toEqual(ok({ ok: true, features: { hud: false, devtools: true } }));
		} finally {
			await served.data.close();
		}
	});

	test("a handler failure comes back as ok: false", async () => {
		const path = join(tempDir(), "control.sock");
		const served = await serveDevControl(path, async () => ({
			ok: false,
			error: "no dashboard",
			features: { hud: false, devtools: false },
		}));
		if (!served.success) throw new Error(served.error);
		try {
			const set = await callDevControl(path, { op: "set", feature: "hud", on: true });
			expect(set).toEqual(ok({ ok: false, error: "no dashboard", features: { hud: false, devtools: false } }));
		} finally {
			await served.data.close();
		}
	});

	test("a stale socket file is replaced", async () => {
		const path = join(tempDir(), "control.sock");
		writeFileSync(path, "");
		const served = await serveDevControl(path, async () => ({ ok: true, features: { hud: true, devtools: true } }));
		expect(served.success).toBe(true);
		if (served.success) await served.data.close();
	});

	test("nothing listening is an error", async () => {
		const called = await callDevControl(join(tempDir(), "none.sock"), { op: "status" }, 500);
		expect(called.success).toBe(false);
	});
});
