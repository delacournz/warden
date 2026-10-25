import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uiDir } from "../agent-ui/paths";
import { type TestContext, testContext } from "../testing";
import { recordedPerfSession, stopPerfAfter } from "./release-after";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(state?: string) {
	const c = testContext([]);
	ctx = c;
	if (state !== undefined) {
		mkdirSync(uiDir(c, "U1"), { recursive: true });
		writeFileSync(join(uiDir(c, "U1"), "state.json"), state);
	}
	return c;
}

describe("stopPerfAfter", () => {
	test("reads the recorded session id as plain JSON", () => {
		const c = setup(JSON.stringify({ perf: { sessionId: "s1" } }));
		expect(recordedPerfSession(c, "U1")).toBe("s1");
		expect(recordedPerfSession(c, "U2")).toBeUndefined();
	});

	test("a device with no session runs nothing", async () => {
		const c = setup();
		const seen: string[] = [];
		await stopPerfAfter(c, async (_c, id) => void seen.push(id))("U1");
		expect(seen).toEqual([]);
	});

	test("a recorded session is stopped", async () => {
		const c = setup(JSON.stringify({ perf: { sessionId: "s1" } }));
		const seen: string[] = [];
		await stopPerfAfter(c, async (_c, id) => void seen.push(id))("U1");
		expect(seen).toEqual(["s1"]);
	});

	test("a throwing stop is reported, not raised", async () => {
		const c = setup(JSON.stringify({ perf: { sessionId: "s1" } }));
		await stopPerfAfter(c, async () => {
			throw new Error("boom");
		})("U1");
		expect(c.stderr.join("\n")).toContain("boom");
	});
});
