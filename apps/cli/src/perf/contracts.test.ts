import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perfFramesResultSchema, perfLsResultSchema, perfMarkResultSchema } from "@delacour/warden-sdk/contracts/perf";
import { uiJsonSchema } from "@delacour/warden-sdk/contracts/ui";
import { perfSessionStore } from "@delacour/warden-sdk/ops/perf/session";
import { fakeExec, type TestContext, testContext } from "../testing";
import { perfFramesCli } from "./frames";
import { perfLsCli } from "./ls";
import { perfMarkCli } from "./mark";
import { perfTestingCli } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");

const T0 = 5_000_000;
const emu = { platform: "android", id: "emulator-5554", name: "Pixel_8" } as const;

function setup() {
	const c = testContext([], {
		exec: fakeExec([
			["adb -s emulator-5554 shell dumpsys gfxinfo com.example.app framestats", { stdout: fx("gfxinfo-90hz.txt") }],
		]),
		now: () => T0,
	});
	ctx = c;
	perfTestingCli.asMe(c);
	c.db.recordDevice({ platform: emu.platform, id: emu.id, name: emu.name }, T0);
	return { c, deps: perfTestingCli.fakePerfDeps([emu]) };
}

const doc = (c: TestContext): unknown => JSON.parse(c.stdout.join("\n"));

test("perf frames --json is a ui envelope whose result parses as the frames contract", async () => {
	const { c, deps } = setup();
	expect(await perfFramesCli.perfFrames(c, deps, { json: true, app: "com.example.app" })).toBe(0);
	const parsed = uiJsonSchema.parse(doc(c));
	if (!parsed.ok) throw new Error("expected ok");
	expect(perfFramesResultSchema.parse(parsed.result)).toMatchObject({ status: "ok", refreshHz: 90 });
});

test("perf mark and perf ls --json results parse as their contracts", async () => {
	const { c, deps } = setup();
	const made = perfSessionStore.createSession(c, deps.session, {
		device: { udid: emu.id, platform: "android", name: emu.name },
		target: { udid: emu.id, ownedByCaller: false },
		maxDurationMs: 60_000,
	});
	if (!made.success) throw new Error("create");
	expect(await perfMarkCli.perfMark(c, deps, ["checkout"], { json: true })).toBe(0);
	const marked = uiJsonSchema.parse(doc(c));
	if (!marked.ok) throw new Error("expected ok");
	expect(perfMarkResultSchema.parse(marked.result)).toMatchObject({ label: "checkout", sessionId: made.data.id });

	c.stdout.length = 0;
	expect(await perfLsCli.perfLs(c, deps, { json: true })).toBe(0);
	const listed = perfLsResultSchema.parse(doc(c));
	expect(listed.sessions.map((s) => s.id)).toEqual([made.data.id]);
});
