import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	fatalReason,
	healthSchema,
	parseUiadLine,
	readNode,
	readSnapshotData,
	settleDataSchema,
	textDataSchema,
	type UiadMessage,
} from "./uiad-protocol";

/** What the real server said on a leased API 37 emulator (`native/android/scripts/record.ts`). */
const SESSION = readFileSync(join(import.meta.dir, "fixtures/uiad-session.ndjson"), "utf8")
	.trim()
	.split("\n");
const BUSY = readFileSync(join(import.meta.dir, "fixtures/uiad-session-busy.ndjson"), "utf8")
	.trim()
	.split("\n");

type Pair = { op: string; request: Record<string, unknown>; reply: UiadMessage };

function messages(lines: readonly string[]): { requests: Record<string, unknown>[]; server: UiadMessage[] } {
	const requests: Record<string, unknown>[] = [];
	const server: UiadMessage[] = [];
	for (const line of lines) {
		const json: unknown = JSON.parse(line);
		if (typeof json === "object" && json !== null && "op" in json) {
			requests.push(json as Record<string, unknown>);
			continue;
		}
		const parsed = parseUiadLine(line);
		if (!parsed.success) throw new Error(`${parsed.reason}: ${line.slice(0, 120)}`);
		server.push(parsed.message);
	}
	return { requests, server };
}

function pairs(): Pair[] {
	const { requests, server } = messages(SESSION);
	return requests.map((request) => {
		const reply = server.find((m) => m.kind === "response" && m.response.id === request.id);
		if (!reply) throw new Error(`no reply for ${JSON.stringify(request)}`);
		return { op: String(request.op), request, reply };
	});
}

const dataOf = (pair: Pair): unknown =>
	pair.reply.kind === "response" && pair.reply.response.ok ? pair.reply.response.data : undefined;

describe("the recorded session", () => {
	test("every line the server wrote parses; log, then ready, then replies", () => {
		const { server } = messages(SESSION);
		expect(server[0]).toMatchObject({ kind: "event", event: { event: "log", level: "debug" } });
		expect(server[1]).toMatchObject({ kind: "event", event: { event: "ready", protocol: 1 } });
		expect(server.slice(2).every((m) => m.kind === "response")).toBe(true);
	});

	test("ready and health carry the same, valid health data", () => {
		const { server } = messages(SESSION);
		const ready = server.find((m) => m.kind === "event" && m.event.event === "ready");
		const health = pairs().find((p) => p.op === "health");
		expect(ready?.kind === "event" && ready.event.event === "ready" ? ready.event.data.sdk : undefined).toBe(37);
		const parsed = healthSchema.parse(health ? dataOf(health) : undefined);
		expect(parsed.uiAutomation.state).toBe("connected");
		expect(parsed.screen).toMatchObject({ width: 1080, height: 2424, rotation: 0 });
	});

	test("snapshot replies read into a tree of typed nodes", () => {
		const snapshots = pairs().filter((p) => p.op === "snapshot");
		expect(snapshots.length).toBeGreaterThanOrEqual(3);
		for (const pair of snapshots) {
			const snapshot = readSnapshotData(dataOf(pair));
			if (typeof snapshot === "string") throw new Error(snapshot);
			expect(snapshot.backend).toBe("uiad");
			expect(snapshot.truncated).toBe(false);
			expect(snapshot.elements[0]?.bounds).toEqual([0, 0, 1080, 2424]);
			const ids: string[] = [];
			const walk = (nodes: readonly { id?: string; children?: readonly unknown[] }[]): void => {
				for (const node of nodes) {
					if (node.id) ids.push(node.id);
					walk((node.children ?? []) as typeof nodes);
				}
			};
			walk(snapshot.elements);
			expect(snapshot.nodes).toBeGreaterThan(5);
			expect(ids.length).toBeGreaterThan(0);
		}
	});

	test("the welcome screen holds the React Native testID as the raw id, the platform ids with their package", () => {
		const first = pairs().find((p) => p.op === "snapshot");
		const snapshot = readSnapshotData(first ? dataOf(first) : undefined);
		if (typeof snapshot === "string") throw new Error(snapshot);
		const ids = new Set<string>();
		const walk = (nodes: readonly { id?: string; children?: readonly unknown[] }[]): void => {
			for (const node of nodes) {
				if (node.id) ids.add(node.id);
				walk((node.children ?? []) as typeof nodes);
			}
		};
		walk(snapshot.elements);
		expect(ids.has("welcome-screen")).toBe(true);
		expect([...ids].some((id) => id.includes(":id/"))).toBe(true);
	});

	test("settle, text and error replies have their shapes", () => {
		const all = pairs();
		const settle = all.find((p) => p.op === "settle");
		expect(settleDataSchema.parse(settle ? dataOf(settle) : undefined)).toMatchObject({ quiet: true, via: "events" });
		const typed = all.filter((p) => p.op === "typeText");
		const texts = typed.map((p) => {
			const data = dataOf(p);
			return data === undefined ? undefined : textDataSchema.parse(data).text;
		});
		expect(texts).toEqual([undefined, "ada@", "ada@example.com", "grace@example.com"]);
		const missing = typed[0]?.reply;
		expect(missing?.kind === "response" && !missing.response.ok ? missing.response.error.code : undefined).toBe(
			"E_NO_ELEMENT"
		);
		const unknown = all.find((p) => p.op === "noSuchOp")?.reply;
		expect(unknown?.kind === "response" && !unknown.response.ok ? unknown.response.error.code : undefined).toBe(
			"E_BAD_REQUEST"
		);
	});

	test("an empty field reads back empty, not as its placeholder", () => {
		const cleared = pairs().find((p) => p.op === "setText");
		expect(textDataSchema.parse(cleared ? dataOf(cleared) : undefined).text).toBe("");
	});
});

describe("a second server while one runs", () => {
	test("is a fatal event naming the busy UiAutomation slot", () => {
		const { server } = messages(BUSY);
		const [fatal] = server;
		if (fatal?.kind !== "event" || fatal.event.event !== "fatal") throw new Error("no fatal event");
		expect(fatal.event.error.code).toBe("E_AX_UNAVAILABLE");
		expect(fatalReason(fatal.event.error)).toBe("uiautomation_busy");
	});
});

describe("parseUiadLine", () => {
	test("tells events from responses and rejects the rest", () => {
		expect(parseUiadLine('{"id":"1","ok":true,"data":{}}').success).toBe(true);
		expect(parseUiadLine('{"event":"log","level":"warn","message":"x"}').success).toBe(true);
		expect(parseUiadLine("not json")).toEqual({ success: false, reason: "not JSON" });
		expect(parseUiadLine('{"event":"ready"}').success).toBe(false);
		expect(parseUiadLine('{"id":1}').success).toBe(false);
	});
});

describe("readNode", () => {
	test("keeps flags and children, and names the path of what is wrong", () => {
		const good = readNode({ bounds: [0, 1, 2, 3], clickable: true, children: [{ bounds: [0, 0, 1, 1], id: "x" }] });
		expect(good).toEqual({ bounds: [0, 1, 2, 3], clickable: true, children: [{ bounds: [0, 0, 1, 1], id: "x" }] });
		expect(readNode({ bounds: [0, 1, 2] })).toBe("elements.bounds: not [l, t, r, b]");
		expect(readNode({ bounds: [0, 0, 1, 1], clickable: "yes" })).toBe("elements.clickable: not a boolean");
		expect(readNode({ bounds: [0, 0, 1, 1], children: [{ bounds: [0, 0, 1, 1], text: 5 }] })).toBe(
			"elements.children[0].text: not a string"
		);
	});
});

describe("readSnapshotData", () => {
	test("rejects a reply from another backend or without elements", () => {
		expect(typeof readSnapshotData({ backend: "ax", elements: [] })).toBe("string");
		expect(typeof readSnapshotData({})).toBe("string");
	});
});

describe("fatalReason", () => {
	test("is undefined without a known detail.reason", () => {
		expect(fatalReason({ code: "E_INTERNAL", message: "x" })).toBeUndefined();
		expect(fatalReason({ code: "E_AX_UNAVAILABLE", message: "x", detail: { reason: "other" } })).toBeUndefined();
		expect(fatalReason({ code: "E_AX_UNAVAILABLE", message: "x", detail: { reason: "connect_failed" } })).toBe(
			"connect_failed"
		);
	});
});
