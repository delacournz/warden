import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerErr } from "./broker.types";
import { type BrokerServer, callBroker, chooseSocketPath, serveBroker } from "./ipc";

const dirs: string[] = [];
const servers: BrokerServer[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "wbk-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(path: string, handle: Parameters<typeof serveBroker>[1]): Promise<BrokerServer> {
	const served = await serveBroker(path, handle);
	if (!served.success) throw new Error(served.error.message);
	servers.push(served.data);
	return served.data;
}

describe("chooseSocketPath", () => {
	test("uses <logDir>/broker.sock when it fits", () => {
		expect(chooseSocketPath("/tmp/a")).toBe("/tmp/a/broker.sock");
	});

	test("falls back to a short temp path for a long log dir, stable per dir", () => {
		const long = `/${"x".repeat(120)}`;
		const path = chooseSocketPath(long, () => "/tmp");
		expect(path).toMatch(/^\/tmp\/warden-[0-9a-f]{12}\.sock$/);
		expect(chooseSocketPath(long, () => "/tmp")).toBe(path);
		expect(chooseSocketPath(`${long}2`, () => "/tmp")).not.toBe(path);
	});
});

describe("serveBroker / callBroker", () => {
	test("round-trips a request and passes method and params to the handler", async () => {
		const path = join(tempDir(), "b.sock");
		const seen: { method: string; params: unknown }[] = [];
		await serve(path, async (method, params) => {
			seen.push({ method, params });
			return { success: true, data: { echoed: params } };
		});
		const result = await callBroker(path, { method: "echo", params: { grep: "x" } });
		expect(result).toEqual({ success: true, data: { echoed: { grep: "x" } } });
		expect(seen).toEqual([{ method: "echo", params: { grep: "x" } }]);
	});

	test("hands a handler error to the caller with its hint", async () => {
		const path = join(tempDir(), "b.sock");
		await serve(path, async () => brokerErr("devtools_unavailable", "yielded", "close DevTools"));
		const result = await callBroker(path, { method: "route", params: {} });
		expect(result).toEqual({
			success: false,
			error: { code: "devtools_unavailable", message: "yielded", hint: "close DevTools" },
		});
	});

	test("answers concurrent requests by id, even when they finish out of order", async () => {
		const path = join(tempDir(), "b.sock");
		await serve(path, async (_method, params) => {
			const { delay, tag } = params as { delay: number; tag: string };
			await new Promise((resolve) => setTimeout(resolve, delay));
			return { success: true, data: tag };
		});
		const [slow, fast] = await Promise.all([
			callBroker(path, { method: "x", params: { delay: 60, tag: "slow" } }),
			callBroker(path, { method: "x", params: { delay: 1, tag: "fast" } }),
		]);
		expect(slow).toEqual({ success: true, data: "slow" });
		expect(fast).toEqual({ success: true, data: "fast" });
	});

	test("streams a response larger than the socket buffer", async () => {
		const path = join(tempDir(), "b.sock");
		const big = "é".repeat(3_000_000);
		await serve(path, async () => ({ success: true, data: big }));
		const result = await callBroker(path, { method: "x", params: {} });
		expect(result).toEqual({ success: true, data: big });
	});

	test("replaces a stale socket file nothing listens on", async () => {
		const path = join(tempDir(), "b.sock");
		writeFileSync(path, "");
		await serve(path, async () => ({ success: true, data: "up" }));
		expect(await callBroker(path, { method: "x", params: {} })).toEqual({ success: true, data: "up" });
	});

	test("refuses to serve over a live broker", async () => {
		const path = join(tempDir(), "b.sock");
		await serve(path, async () => ({ success: true, data: 1 }));
		const second = await serveBroker(path, async () => ({ success: true, data: 2 }));
		expect(second.success).toBe(false);
		expect(await callBroker(path, { method: "x", params: {} })).toEqual({ success: true, data: 1 });
	});

	test("close removes the socket file and later calls are broker_unreachable", async () => {
		const path = join(tempDir(), "b.sock");
		const server = await serve(path, async () => ({ success: true, data: 1 }));
		await server.close();
		expect(existsSync(path)).toBe(false);
		const result = await callBroker(path, { method: "x", params: {} });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("broker_unreachable");
	});

	test("times out when the handler never answers", async () => {
		const path = join(tempDir(), "b.sock");
		await serve(path, () => new Promise(() => undefined));
		const result = await callBroker(path, { method: "x", params: {} }, { timeoutMs: 50 });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("timeout");
	});

	test("a handler that throws becomes an error reply, not a hang", async () => {
		const path = join(tempDir(), "b.sock");
		await serve(path, async () => {
			throw new Error("boom");
		});
		const result = await callBroker(path, { method: "x", params: {} });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.message).toContain("boom");
	});
});
