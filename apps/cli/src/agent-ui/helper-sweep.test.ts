import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, testContext } from "../testing";
import { findDeadHelpers, sweepDeadHelpersLazily } from "./helper-sweep";
import { uiDir } from "./paths";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function host(): TestContext {
	ctx?.cleanup();
	ctx = testContext([]);
	return ctx;
}

/** `state.json` for `udid`, written as plain JSON (the sweep must not need the state schema to read it). */
function writeRecord(c: TestContext, udid: string, body: unknown): void {
	mkdirSync(uiDir(c, udid), { recursive: true });
	writeFileSync(join(uiDir(c, udid), "state.json"), typeof body === "string" ? body : JSON.stringify(body));
}

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe("findDeadHelpers", () => {
	test("nothing recorded: no udids, no dirs needed", () => {
		expect(findDeadHelpers(host(), alive([]))).toEqual([]);
	});

	test("a record whose pid is gone is dead; a live pid, no helper, garbage and a missing file are not", () => {
		const c = host();
		writeRecord(c, "DEAD", { generation: 1, helper: { pid: 10, socket: "/s/DEAD.sock" } });
		writeRecord(c, "LIVE", { generation: 1, helper: { pid: 20, socket: "/s/LIVE.sock" } });
		writeRecord(c, "NONE", { generation: 1 });
		writeRecord(c, "JUNK", "{ nope");
		writeRecord(c, "ODD", { generation: 1, helper: { pid: "x", socket: 3 } });
		mkdirSync(uiDir(c, "EMPTY"), { recursive: true });
		expect(findDeadHelpers(c, alive([20]))).toEqual(["DEAD"]);
	});

	test("udids come from both the simd sockets and the ui dirs, each once", () => {
		const c = host();
		mkdirSync(join(c.cwd, "simd"), { recursive: true });
		writeFileSync(join(c.cwd, "simd", "A.sock"), "");
		writeFileSync(join(c.cwd, "simd", "A.log"), "");
		writeRecord(c, "A", { generation: 0, helper: { pid: 1, socket: join(c.cwd, "simd", "A.sock") } });
		writeRecord(c, "B", { generation: 0, helper: { pid: 2, socket: "/s/B.sock" } });
		expect(findDeadHelpers(c, alive([])).sort()).toEqual(["A", "B"]);
	});
});

describe("sweepDeadHelpersLazily", () => {
	function loader() {
		const loads = { count: 0 };
		const load = async () => {
			loads.count += 1;
			return await import("./helper");
		};
		return { loads, load };
	}

	test("nothing dead: the helper module (e2e driver, zod) is never imported", async () => {
		const c = host();
		const l = loader();
		writeRecord(c, "LIVE", { generation: 1, helper: { pid: 20, socket: "/s/LIVE.sock" } });
		expect(await sweepDeadHelpersLazily(c, { pidAlive: alive([20]), load: l.load })).toEqual([]);
		expect(l.loads.count).toBe(0);
	});

	test("a dead helper: imports the module once and sweeps it like sweepDeadHelpers", async () => {
		const c = host();
		const l = loader();
		const dir = join(c.cwd, "simd");
		mkdirSync(dir, { recursive: true });
		const dead = join(dir, "DEAD.sock");
		const live = join(dir, "LIVE.sock");
		writeFileSync(dead, "");
		writeFileSync(live, "");
		writeRecord(c, "DEAD", { generation: 0, updatedAt: 0, helper: { pid: 1, socket: dead } });
		writeRecord(c, "LIVE", { generation: 0, updatedAt: 0, helper: { pid: 2, socket: live } });
		expect(await sweepDeadHelpersLazily(c, { pidAlive: alive([2]), load: l.load })).toEqual([dead]);
		expect(l.loads.count).toBe(1);
		expect(existsSync(dead)).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(findDeadHelpers(c, alive([2]))).toEqual([]);
	});
});
