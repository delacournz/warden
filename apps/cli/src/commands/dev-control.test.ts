import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type DevFeatures, serveDevControl } from "../dev-control";
import { writeDevSession } from "../dev-session";
import { type TestContext, testContext } from "../testing";
import { devControl } from "./dev-control";

let ctx: TestContext | undefined;
let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => {
	await closeServer?.();
	closeServer = undefined;
	ctx?.cleanup();
});

const alive = { isAlive: () => true };

/** A dev session in a temp WARDEN_HOME, with a control socket that flips `features` (or none: `serve: false`). */
async function withSession(options: { serve: boolean; failHud?: boolean }) {
	const c = testContext([]);
	ctx = c;
	const logDir = join(c.env.WARDEN_HOME ?? "", "dev", "L1");
	mkdirSync(logDir, { recursive: true });
	const features: DevFeatures = { hud: false, devtools: false };
	const socket = join(logDir, "control.sock");
	if (options.serve) {
		const served = await serveDevControl(socket, async (request) => {
			if (request.op === "status") return { ok: true, features: { ...features } };
			if (request.feature === "hud" && options.failHud)
				return { ok: false, error: "no dashboard", features: { ...features } };
			features[request.feature] = request.on;
			return { ok: true, features: { ...features } };
		});
		if (!served.success) throw new Error(served.error);
		closeServer = served.data.close;
	}
	writeDevSession(c.env, {
		version: 1,
		leaseId: "L1",
		pid: process.pid,
		platform: "ios",
		deviceId: "UDID-1",
		port: 8101,
		metroUrl: "http://localhost:8101",
		logDir,
		projectRoot: "/work/example",
		startedAt: "2026-10-28T00:00:00.000Z",
		...(options.serve ? { controlSocket: socket } : {}),
	});
	return { c, features };
}

describe("warden dev enable|disable|status", () => {
	test("enable turns each named feature on and prints the state", async () => {
		const { c, features } = await withSession({ serve: true });
		expect(await devControl(c, "enable", ["perf", "devtools"], {}, alive)).toBe(0);
		expect(features).toEqual({ hud: true, devtools: true });
		expect(c.stdout.join("\n")).toContain("hud on");
		expect(c.stdout.join("\n")).toContain("devtools on");
	});

	test("disable all, --json prints the features", async () => {
		const { c, features } = await withSession({ serve: true });
		features.hud = true;
		features.devtools = true;
		expect(await devControl(c, "disable", ["all"], { json: true }, alive)).toBe(0);
		expect(JSON.parse(c.stdout.join(""))).toEqual({ udid: "UDID-1", features: { hud: false, devtools: false } });
	});

	test("status reads without changing anything", async () => {
		const { c, features } = await withSession({ serve: true });
		features.devtools = true;
		expect(await devControl(c, "status", [], { json: true }, alive)).toBe(0);
		expect(JSON.parse(c.stdout.join(""))).toEqual({ udid: "UDID-1", features: { hud: false, devtools: true } });
	});

	test("a feature the session refuses fails with its reason, the others still apply", async () => {
		const { c, features } = await withSession({ serve: true, failHud: true });
		expect(await devControl(c, "enable", ["all"], {}, alive)).toBe(1);
		expect(features.devtools).toBe(true);
		expect(c.stderr.join("\n")).toContain("no dashboard");
	});

	test("an unknown feature is a usage error", async () => {
		const { c } = await withSession({ serve: true });
		expect(await devControl(c, "enable", ["cpu"], {}, alive)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown feature");
	});

	test("a session without a control socket (older warden) says so", async () => {
		const { c } = await withSession({ serve: false });
		expect(await devControl(c, "enable", ["hud"], {}, alive)).toBe(1);
		expect(c.stderr.join("\n")).toContain("no control socket");
	});

	test("no session", async () => {
		const c = testContext([]);
		ctx = c;
		expect(await devControl(c, "status", [], {}, alive)).toBe(1);
		expect(c.stderr.join("\n")).toContain("no running `warden dev` session");
	});
});
