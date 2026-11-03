import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import { createSimRunner, parseRunnerReady, simRunnerArgv, TEST_FILTER } from "./sim-runner";
import type { SimdClient } from "./simd-client";
import type { SimdProcess } from "./simd-transport";

const encoder = new TextEncoder();

function stream(lines: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
		},
	});
}

/** A runner process that prints `lines` and then stays alive until killed (or exits at once when `exitNow`). */
function fakeProcess(lines: string[], exitNow = false): SimdProcess & { killed: boolean } {
	let finish: (code: number) => void = () => undefined;
	const exited = new Promise<number>((resolve) => {
		finish = resolve;
	});
	if (exitNow) finish(65);
	const proc = {
		killed: false,
		write() {},
		end() {},
		kill() {
			proc.killed = true;
			finish(0);
		},
		stdout: stream(lines),
		exited,
	};
	return proc;
}

const READY = `WARDEN_RUNNER_READY ${JSON.stringify({ event: "ready", port: 53001 })}`;

function fakeClient(requests: Array<{ op: string; params?: Record<string, unknown> }>): SimdClient {
	return {
		ready: {} as SimdClient["ready"],
		request: (async (op: string, params?: Record<string, unknown>) => {
			requests.push({ op, ...(params ? { params } : {}) });
			return { success: true, data: { issues: [], count: 0 } };
		}) as SimdClient["request"],
		on: () => () => undefined,
		close: async () => undefined,
	};
}

describe("parseRunnerReady", () => {
	test("reads the port out of the ready line, however xcodebuild prefixes it", () => {
		expect(parseRunnerReady(READY)).toBe(53001);
		expect(parseRunnerReady(`2026-10-30 12:00:00.123 xcodebuild[1]  ${READY}`)).toBe(53001);
	});
	test("ignores other lines and a port that is not a positive integer", () => {
		expect(parseRunnerReady("Test Suite 'All tests' started")).toBeUndefined();
		expect(parseRunnerReady(`WARDEN_RUNNER_READY {"port":0}`)).toBeUndefined();
		expect(parseRunnerReady("WARDEN_RUNNER_READY not json")).toBeUndefined();
	});
});

describe("simRunnerArgv", () => {
	test("serves testServe on the simulator with the runner's env", () => {
		const argv = simRunnerArgv({ xctestrun: "/dd/x.xctestrun", udid: "U-1" });
		expect(argv.slice(0, 3)).toEqual([
			"env",
			"TEST_RUNNER_WARDEN_RUNNER_UDID=U-1",
			"TEST_RUNNER_WARDEN_RUNNER_IDLE_SECONDS=600",
		]);
		expect(argv).toContain("test-without-building");
		expect(argv).toContain("id=U-1");
		expect(argv.at(-1)).toBe(TEST_FILTER);
	});
});

describe("createSimRunner", () => {
	test("starts once, connects to the printed port and reuses the runner for every request", async () => {
		const procs: Array<ReturnType<typeof fakeProcess>> = [];
		const ports: number[] = [];
		const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
		let builds = 0;
		const runner = createSimRunner({
			udid: "U-1",
			ensureBuild: async () => {
				builds++;
				return ok({ xctestrun: "/dd/x.xctestrun" });
			},
			spawn: () => {
				const p = fakeProcess(["noise", READY]);
				procs.push(p);
				return p;
			},
			connect: async (port) => {
				ports.push(port);
				return ok(fakeClient(requests));
			},
		});
		await runner.request("audit", { bundleId: "a" });
		await runner.request("audit", { bundleId: "b" });
		expect(builds).toBe(1);
		expect(procs).toHaveLength(1);
		expect(ports).toEqual([53001]);
		expect(requests.map((r) => r.params)).toEqual([{ bundleId: "a" }, { bundleId: "b" }]);
		await runner.close();
		expect(procs[0]?.killed).toBe(true);
	});

	test("a missing build is E_UNSUPPORTED with the reason, and the next request tries again", async () => {
		let calls = 0;
		const runner = createSimRunner({
			udid: "U-1",
			ensureBuild: async () => {
				calls++;
				return { success: false, error: "no usable Xcode" };
			},
		});
		const first = await runner.request("audit");
		expect(first.success).toBe(false);
		if (!first.success) {
			expect(first.error.code).toBe("E_UNSUPPORTED");
			expect(first.error.message).toContain("no usable Xcode");
		}
		await runner.request("audit");
		expect(calls).toBe(2);
	});

	test("a runner that exits before it is ready is E_HELPER_CRASHED with the output tail", async () => {
		const runner = createSimRunner({
			udid: "U-1",
			ensureBuild: async () => ok({ xctestrun: "/x" }),
			spawn: () => fakeProcess(["error: Unable to boot the Simulator"], true),
		});
		const res = await runner.request("audit");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.code).toBe("E_HELPER_CRASHED");
	});

	test("a runner that never says ready times out and is killed", async () => {
		const proc = fakeProcess(["still building"]);
		const runner = createSimRunner({
			udid: "U-1",
			ensureBuild: async () => ok({ xctestrun: "/x" }),
			spawn: () => proc,
			readyTimeoutMs: 30,
		});
		const res = await runner.request("audit");
		expect(res.success).toBe(false);
		expect(proc.killed).toBe(true);
	});
});
