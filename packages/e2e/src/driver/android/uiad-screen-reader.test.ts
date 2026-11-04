import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DriverError } from "../driver.types";
import type { AdbSession } from "./adb-session";
import { type FakeReply, type FakeRequest, fakeUiad } from "./uiad.testing";
import { createUiadBackend } from "./uiad-backend";
import { startUiad } from "./uiad-client";
import { createUiadOps } from "./uiad-ops";
import { parseScrolled, parseSrEvents, parseSrFocus, parseSrFocused } from "./uiad-screen-reader";

/**
 * Replies recorded from `warden-uiad` 0.6.0 on an API 37 emulator with TalkBack 17 bound, driving the Android Settings
 * app (`fixtures/uiad-screen-reader.ndjson`, recorded by hand: Settings home, `srFocus next` x2, `prev`, `actionScroll`,
 * `srActivate`, `actionClick`, the two refusals).
 */

const SCREEN = { width: 1080, height: 2400, scale: 2.625 };

type Pair = { request: FakeRequest; reply: FakeReply };

function recorded(): Pair[] {
	const pairs: Pair[] = [];
	const requests = new Map<string, FakeRequest>();
	for (const line of readFileSync(join(import.meta.dir, "fixtures/uiad-screen-reader.ndjson"), "utf8")
		.trim()
		.split("\n")) {
		const json = JSON.parse(line) as Record<string, unknown>;
		if (typeof json.op === "string" && typeof json.id === "string") requests.set(json.id, json as FakeRequest);
		else if (typeof json.id === "string") {
			const request = requests.get(json.id);
			if (request) {
				pairs.push({
					request,
					reply: json.ok === true ? { data: json.data } : { error: json.error as DriverError & { retryable: boolean } },
				});
			}
		}
	}
	return pairs;
}

const reply = (id: string): unknown => {
	const reply = recorded().find((p) => p.request.id === id)?.reply;
	return typeof reply === "object" && "data" in reply ? reply.data : undefined;
};

describe("recorded replies", () => {
	test("srFocus answers the node with its subtree, an index and a count", () => {
		const parsed = parseSrFocus(reply("r3"), SCREEN);
		expect(parsed.success).toBe(true);
		if (!parsed.success || parsed.data.element === undefined) return;
		expect(parsed.data.element.traits).toContain("clickable");
		expect(parsed.data.element.a11y).toMatchObject({ focusable: true, a11yFocused: true });
		expect(parsed.data.element.children.length).toBeGreaterThan(0);
		expect(parsed.data.count).toBeGreaterThan(5);
		expect(parsed.data.index).toBe(1);
	});
	test("srFocused is null before TalkBack has focus, a node after", () => {
		expect(parseSrFocused(reply("r1"), SCREEN)).toEqual({ success: true, data: undefined });
		const node = parseSrFocused(reply("r4"), SCREEN);
		expect(node.success && node.data?.a11y?.a11yFocused).toBe(true);
	});
	test("srEvents lists each focus move with its node and a cursor", () => {
		const parsed = parseSrEvents(reply("r6"), SCREEN);
		expect(parsed.success && parsed.data.events.length).toBeGreaterThanOrEqual(3);
		expect(parsed.success && parsed.data.cursor).toBeGreaterThanOrEqual(3);
		expect(parsed.success && parsed.data.events.every((e) => e.at > 0)).toBe(true);
	});
	test("actionScroll answers whether the content moved", () => {
		expect(parseScrolled(reply("r8"))).toEqual({ success: true, data: true });
	});
	test("a reply of the wrong shape is a parse error, not a throw", () => {
		expect(parseSrFocus({ node: 3 }, SCREEN).success).toBe(false);
		expect(parseSrFocus(null, SCREEN).success).toBe(false);
		expect(parseSrEvents({ events: [{ at: 1, node: { nope: true } }], cursor: 1 }, SCREEN).success).toBe(false);
		expect(parseScrolled({}).success).toBe(false);
	});
});

const SESSION: AdbSession = {
	async run() {
		return { success: true, data: { stdout: "", exitCode: 0 } };
	},
	async close() {},
};
const open: Array<{ stop(): Promise<void> }> = [];

/** The ops over a real client and an in-process server that answers each op from the recording, in order. */
function setup() {
	const pairs = recorded();
	const used = new Map<string, number>();
	const fake = fakeUiad({
		handle: (request) => {
			const matching = pairs.filter((p) => p.request.op === request.op);
			const nth = used.get(request.op) ?? 0;
			used.set(request.op, nth + 1);
			return matching[Math.min(nth, matching.length - 1)]?.reply;
		},
	});
	const clock = { now: () => 1_000, sleep: async () => undefined };
	const backend = createUiadBackend({
		session: SESSION,
		adb: "adb",
		serial: "emulator-5554",
		clock,
		options: {},
		launch: async () => startUiad({ cmd: ["adb", "shell", "x"], spawn: fake.spawn, graceMs: 20 }),
	});
	const ops = createUiadOps({ backend, baseScreen: SCREEN, clock });
	open.push(ops);
	return { fake, ops };
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((o) => o.stop()));
});

describe("uiad ops over the recorded server", () => {
	test("srFocus sends the direction, or a point", async () => {
		const { fake, ops } = setup();
		const next = await ops.srFocus({ dir: "next" });
		expect(next?.success && next.data.element?.traits).toContain("clickable");
		await ops.srFocus({ point: { x: 540, y: 719 } });
		expect(fake.of("srFocus").map(({ id: _id, op: _op, ...rest }) => rest)).toEqual([
			{ dir: "next" },
			{ x: 540, y: 719 },
		]);
	});
	test("a refused srActivate is the error, not a fallback", async () => {
		const { ops } = setup();
		// the first recorded srActivate succeeded; the last is the refusal, so ask twice
		await ops.srActivate();
		const second = await ops.srActivate();
		expect(second?.success).toBe(false);
		expect(!second?.success && second?.error.code).toBe("E_NO_ELEMENT");
	});
	test("a refused actionClick falls back (undefined) so the driver can focus and double-tap", async () => {
		const { ops } = setup();
		await ops.actionClick({ x: 540, y: 1500 });
		expect(await ops.actionClick({ x: 5, y: 5 })).toBeUndefined();
	});
	test("actionScroll sends the direction and the point", async () => {
		const { fake, ops } = setup();
		const moved = await ops.actionScroll("forward", { x: 1, y: 2 });
		expect(moved).toEqual({ success: true, data: true });
		expect(fake.of("actionScroll")[0]).toMatchObject({ dir: "forward", x: 1, y: 2 });
	});
});
