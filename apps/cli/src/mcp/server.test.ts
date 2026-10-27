import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { brokerErr } from "../dev-broker/broker.types";
import { serveBroker } from "../dev-broker/ipc";
import { writeDevSession } from "../dev-session";
import { createWardenMcp, toResponse } from "./server";
import { type ToolDef, wardenTools } from "./tools";

const homes: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): Record<string, string> {
	const dir = mkdtempSync(join(tmpdir(), "warden-mcp-"));
	homes.push(dir);
	return { WARDEN_HOME: dir };
}

async function connect(env: Record<string, string | undefined>, tools: readonly ToolDef[]): Promise<Client> {
	const server = createWardenMcp(env, tools, "0.0.0-test");
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "test", version: "1" });
	await client.connect(clientSide);
	return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>): unknown => {
	const [first] = result.content as { type: string; text: string }[];
	return JSON.parse(first?.text ?? "null");
};

describe("toResponse", () => {
	test("data is one JSON text block; an error is `{ error }` with isError", () => {
		expect(toResponse(ok({ a: 1 }))).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
		expect(toResponse({ success: false, error: { code: "x", message: "m" } })).toEqual({
			content: [{ type: "text", text: '{"error":{"code":"x","message":"m"}}' }],
			isError: true,
		});
	});
});

describe("warden mcp", () => {
	test("lists every warden tool with its input schema", async () => {
		const client = await connect(home(), wardenTools());
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("dev_sessions");
		expect(names).toContain("metro_logs");
		const metro = tools.find((t) => t.name === "metro_logs");
		expect(Object.keys(metro?.inputSchema.properties ?? {})).toEqual(["udid", "since", "tail", "grep", "kinds"]);
	});

	test("a throwing tool answers an internal error instead of dropping the connection", async () => {
		const boom: ToolDef = {
			name: "boom",
			description: "throws",
			input: { n: z.number() },
			run: async () => {
				throw new Error("kaboom");
			},
		};
		const client = await connect(home(), [boom]);
		const result = await client.callTool({ name: "boom", arguments: { n: 1 } });
		expect(result.isError).toBe(true);
		expect(text(result)).toEqual({ error: { code: "internal", message: "kaboom" } });
	});

	test("metro_logs reads the live session's metro.log, classified and filtered", async () => {
		const env = home();
		const logDir = join(env.WARDEN_HOME as string, "dev", "lease-1");
		mkdirSync(logDir, { recursive: true });
		writeFileSync(
			join(logDir, "metro.log"),
			"Starting Metro Bundler\r\nERROR  SyntaxError: /app/src/App.tsx: Unexpected token (3:4)\r\n"
		);
		writeDevSession(env, {
			version: 1,
			leaseId: "lease-1",
			pid: process.pid,
			platform: "ios",
			deviceId: "UDID-1",
			port: 8081,
			metroUrl: "http://127.0.0.1:8081",
			logDir,
			projectRoot: "/app",
			startedAt: new Date(0).toISOString(),
		});
		const client = await connect(env, wardenTools());
		const sessions = text(await client.callTool({ name: "dev_sessions", arguments: {} }));
		expect(sessions).toMatchObject([{ leaseId: "lease-1", deviceId: "UDID-1" }]);
		const errors = await client.callTool({ name: "metro_logs", arguments: { kinds: ["error", "bundle_failed"] } });
		expect(errors.isError).toBeUndefined();
		const entries = text(errors) as { kind: string; text: string }[];
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((e) => e.kind === "error" || e.kind === "bundle_failed")).toBe(true);
	});

	test("metro_logs with no dev session and a bad since are tool errors", async () => {
		const client = await connect(home(), wardenTools());
		const none = await client.callTool({ name: "metro_logs", arguments: {} });
		expect(none.isError).toBe(true);
		expect(text(none)).toMatchObject({ error: { code: "no_dev_session" } });
		const bad = await client.callTool({ name: "metro_logs", arguments: { since: "yesterday-ish" } });
		expect(text(bad)).toMatchObject({ error: { code: "invalid_query" } });
	});
});

describe("warden mcp over the dev session's broker", () => {
	const NOW = 1_700_000_000_000;

	/** A live dev session whose broker stub records what each tool asked for. */
	async function brokered(): Promise<{ env: Record<string, string>; calls: { method: string; params: unknown }[] }> {
		const env = home();
		const calls: { method: string; params: unknown }[] = [];
		const dir = mkdtempSync(join(tmpdir(), "wmb-"));
		homes.push(dir);
		const served = await serveBroker(join(dir, "b.sock"), async (method, params) => {
			calls.push({ method, params });
			if (method === "status") return ok({ state: { phase: "attached", targetId: "t", deviceName: "sim" } });
			if (method === "console.query")
				return ok({ lines: [{ ts: NOW, level: "error", kind: "console", text: "boom" }], total: 1 });
			if (method === "eval") return ok({ value: 42 });
			if (method === "route") return ok({ route: "(tabs)/home" });
			return brokerErr("unknown_method", method);
		});
		if (!served.success) throw new Error(served.error.message);
		const server = served.data;
		closers.push(() => server.close());
		writeDevSession(env, {
			version: 1,
			leaseId: "lease-1",
			pid: process.pid,
			platform: "ios",
			deviceId: "UDID-1",
			port: 8081,
			metroUrl: "http://127.0.0.1:8081",
			logDir: join(env.WARDEN_HOME as string, "dev", "lease-1"),
			projectRoot: "/app",
			startedAt: new Date(0).toISOString(),
			brokerSocket: server.socketPath,
		});
		return { env, calls };
	}

	test("app_console passes filters through with since as epoch ms", async () => {
		const { env, calls } = await brokered();
		const client = await connect(env, wardenTools({ now: () => NOW }));
		const result = await client.callTool({ name: "app_console", arguments: { since: "30s", level: "error" } });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toMatchObject({ total: 1, lines: [{ text: "boom" }] });
		expect(calls.find((c) => c.method === "console.query")?.params).toEqual({ level: "error", since: NOW - 30_000 });
	});

	test("app_eval and app_route answer from the broker", async () => {
		const { env } = await brokered();
		const client = await connect(env, wardenTools({ now: () => NOW }));
		expect(text(await client.callTool({ name: "app_eval", arguments: { expression: "6 * 7" } }))).toEqual({
			value: 42,
		});
		expect(text(await client.callTool({ name: "app_route", arguments: {} }))).toEqual({ route: "(tabs)/home" });
	});
});
