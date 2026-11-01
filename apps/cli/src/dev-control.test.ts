import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultFactory } from "@delacour/warden-types/result";
import { type DevFeatures, devControlOps } from "./dev-control";

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
		expect(devControlOps.parseDevFeatures(["hud"])).toEqual(resultFactory.ok(["hud"]));
		expect(devControlOps.parseDevFeatures(["perf", "devtools"])).toEqual(resultFactory.ok(["hud", "devtools"]));
		expect(devControlOps.parseDevFeatures(["all"])).toEqual(resultFactory.ok(["hud", "devtools"]));
		expect(devControlOps.parseDevFeatures(["hud,devtools", "hud"])).toEqual(resultFactory.ok(["hud", "devtools"]));
	});

	test("an unknown name is an error naming the valid ones", () => {
		const parsed = devControlOps.parseDevFeatures(["cpu"]);
		expect(parsed.success).toBe(false);
		if (!parsed.success) expect(parsed.error).toContain("hud | perf | devtools | all");
	});
});

describe("parseDevControlRequest", () => {
	test("set and status", () => {
		expect(devControlOps.parseDevControlRequest({ op: "set", feature: "devtools", on: true })).toEqual({
			op: "set",
			feature: "devtools",
			on: true,
		});
		expect(devControlOps.parseDevControlRequest({ op: "status" })).toEqual({ op: "status" });
	});

	test("anything else is undefined", () => {
		expect(devControlOps.parseDevControlRequest({ op: "set", feature: "cpu", on: true })).toBeUndefined();
		expect(devControlOps.parseDevControlRequest({ op: "set", feature: "hud" })).toBeUndefined();
		expect(devControlOps.parseDevControlRequest("status")).toBeUndefined();
	});
});

describe("controlSocketPath", () => {
	test("<logDir>/control.sock, else a short temp path", () => {
		expect(devControlOps.controlSocketPath("/w/dev/abc")).toBe("/w/dev/abc/control.sock");
		const long = `/${"x".repeat(120)}`;
		expect(devControlOps.controlSocketPath(long, () => "/t")).toMatch(/^\/t\/warden-ctl-[0-9a-f]{12}\.sock$/);
	});
});

describe("serveDevControl + callDevControl", () => {
	test("a set is answered with the features after it", async () => {
		const path = join(tempDir(), "control.sock");
		const features: DevFeatures = { hud: false, devtools: false };
		const served = await devControlOps.serveDevControl(path, async (request) => {
			if (request.op === "set") features[request.feature] = request.on;
			return { ok: true, features: { ...features } };
		});
		expect(served.success).toBe(true);
		if (!served.success) return;
		try {
			const set = await devControlOps.callDevControl(path, { op: "set", feature: "devtools", on: true });
			expect(set).toEqual(resultFactory.ok({ ok: true, features: { hud: false, devtools: true } }));
			const status = await devControlOps.callDevControl(path, { op: "status" });
			expect(status).toEqual(resultFactory.ok({ ok: true, features: { hud: false, devtools: true } }));
		} finally {
			await served.data.close();
		}
	});

	test("a handler failure comes back as ok: false", async () => {
		const path = join(tempDir(), "control.sock");
		const served = await devControlOps.serveDevControl(path, async () => ({
			ok: false,
			error: "no dashboard",
			features: { hud: false, devtools: false },
		}));
		if (!served.success) throw new Error(served.error);
		try {
			const set = await devControlOps.callDevControl(path, { op: "set", feature: "hud", on: true });
			expect(set).toEqual(
				resultFactory.ok({ ok: false, error: "no dashboard", features: { hud: false, devtools: false } })
			);
		} finally {
			await served.data.close();
		}
	});

	test("a stale socket file is replaced", async () => {
		const path = join(tempDir(), "control.sock");
		writeFileSync(path, "");
		const served = await devControlOps.serveDevControl(path, async () => ({
			ok: true,
			features: { hud: true, devtools: true },
		}));
		expect(served.success).toBe(true);
		if (served.success) await served.data.close();
	});

	test("nothing listening is an error", async () => {
		const called = await devControlOps.callDevControl(join(tempDir(), "none.sock"), { op: "status" }, 500);
		expect(called.success).toBe(false);
	});
});
