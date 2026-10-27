import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDevSession } from "../dev-session";
import { testContext } from "../testing";
import { resumeBrokerOnClose, settleBrokerResumes } from "./broker-resume";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resumeBrokerOnClose", () => {
	test("closing the capture session with no dev session closes once and resumes nothing", async () => {
		const home = mkdtempSync(join(tmpdir(), "wbr-"));
		dirs.push(home);
		const ctx = testContext([], { env: { WARDEN_HOME: home } });
		let closed = 0;
		const session = resumeBrokerOnClose(ctx, "U1", { close: () => closed++ });
		session.close();
		await settleBrokerResumes();
		expect(closed).toBe(1);
		ctx.cleanup();
	});

	test("with a dev session whose broker is gone, close still completes", async () => {
		const home = mkdtempSync(join(tmpdir(), "wbr-"));
		dirs.push(home);
		const env = { WARDEN_HOME: home };
		writeDevSession(env, {
			version: 1,
			leaseId: "L1",
			pid: process.pid,
			platform: "ios",
			deviceId: "U1",
			port: 8081,
			metroUrl: "http://127.0.0.1:8081",
			logDir: home,
			projectRoot: home,
			startedAt: "2026-10-27T10:00:00Z",
			brokerSocket: join(home, "gone.sock"),
		});
		const ctx = testContext([], { env });
		let closed = 0;
		resumeBrokerOnClose(ctx, "U1", { close: () => closed++ }).close();
		await settleBrokerResumes();
		expect(closed).toBe(1);
		ctx.cleanup();
	});
});
