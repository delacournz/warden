import { describe, expect, test } from "bun:test";
import { type AccessUnit, AuFlag, nalTypes } from "./au-framing";
import {
	parseWmSize,
	type RecorderProcess,
	screenrecordArgv,
	screenrecordSize,
	startScreenrecordSource,
} from "./screenrecord";

const sc = [0, 0, 0, 1];
const KEY = new Uint8Array([
	...sc,
	0x67,
	0x42,
	0xc0,
	0x1f,
	...sc,
	0x68,
	0xce,
	0x3c,
	0x80,
	...sc,
	0x65,
	0x88,
	0x84,
	0x21,
]);
const P = (n: number) => new Uint8Array([...sc, 0x41, 0x9a, n]);

describe("parseWmSize", () => {
	test("the override wins over the physical size", () => {
		expect(parseWmSize("Physical size: 1080x2424\n")).toEqual({ width: 1080, height: 2424 });
		expect(parseWmSize("Physical size: 1080x2424\nOverride size: 720x1616\n")).toEqual({ width: 720, height: 1616 });
		expect(parseWmSize("nope")).toBeUndefined();
	});
});

describe("screenrecordSize", () => {
	test("half the display, even sides, then the long side capped at maxEdge (0 = no cap)", () => {
		expect(screenrecordSize({ width: 1080, height: 2424 }, 1280)).toEqual({ width: 540, height: 1212 });
		expect(screenrecordSize({ width: 1080, height: 2424 }, 1000)).toEqual({ width: 444, height: 1000 });
		expect(screenrecordSize({ width: 1081, height: 2401 }, 0)).toEqual({ width: 540, height: 1200 });
	});
});

describe("screenrecordArgv", () => {
	test("raw H.264 on stdout over exec-out, size, bit rate and the time limit", () => {
		expect(screenrecordArgv("/adb", "emulator-5554", { width: 540, height: 1212 }, 4_000_000, 180)).toEqual([
			"/adb",
			"-s",
			"emulator-5554",
			"exec-out",
			"screenrecord",
			"--output-format=h264",
			"--size",
			"540x1212",
			"--bit-rate",
			"4000000",
			"--time-limit",
			"180",
			"-",
		]);
	});
});

/** A scripted recorder process: the test pushes bytes and ends it. */
function fakeProcess() {
	let push: (chunk: Uint8Array) => void = () => undefined;
	let end: () => void = () => undefined;
	let exit: (code: number) => void = () => undefined;
	const exited = new Promise<number>((resolve) => {
		exit = resolve;
	});
	let killed = false;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			push = (chunk) => {
				if (!killed) controller.enqueue(chunk);
			};
			end = () => {
				try {
					controller.close();
				} catch {}
			};
		},
	});
	const process: RecorderProcess = {
		stdout,
		exited,
		kill: () => {
			killed = true;
			end();
			exit(143);
		},
	};
	return {
		process,
		push,
		finish: (code = 0) => {
			end();
			exit(code);
		},
		killed: () => killed,
	};
}

const until = async (check: () => boolean, ms = 2_000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await Bun.sleep(2);
	return check();
};

describe("startScreenrecordSource", () => {
	function harness(restartAfterMs = 60_000) {
		const procs: ReturnType<typeof fakeProcess>[] = [];
		const units: AccessUnit[] = [];
		const source = startScreenrecordSource({
			argv: ["adb", "screenrecord"],
			spawn: () => {
				const p = fakeProcess();
				procs.push(p);
				return p.process;
			},
			onUnit: (u) => units.push(u),
			restartAfterMs,
			idleDrainMs: 1,
			now: () => 5_000,
		});
		return { procs, units, source };
	}

	test("each frame leaves as its own unit once the recorder goes quiet, pts from the clock", async () => {
		const { procs, units, source } = harness();
		procs[0]?.push(KEY);
		expect(await until(() => units.length === 1)).toBe(true);
		procs[0]?.push(P(1));
		expect(await until(() => units.length === 2)).toBe(true);
		expect(units.map((u) => u.flags)).toEqual([AuFlag.key | AuFlag.config, 0]);
		expect(units[1]?.ptsMicros).toBe(0n);
		source.stop();
		expect(procs[0]?.killed()).toBe(true);
	});

	test("a keyframe request starts a second recorder; the first keeps streaming until the second's IDR, then is killed", async () => {
		const { procs, units, source } = harness();
		procs[0]?.push(KEY);
		await until(() => units.length === 1);
		source.requestKeyframe();
		source.requestKeyframe();
		expect(procs).toHaveLength(2);
		procs[0]?.push(P(1));
		await until(() => units.length === 2);
		procs[1]?.push(KEY);
		expect(await until(() => units.length === 3)).toBe(true);
		expect(units[2]?.flags).toBe(AuFlag.key | AuFlag.config);
		expect(procs[0]?.killed()).toBe(true);
		procs[0]?.push(P(9));
		procs[1]?.push(P(2));
		expect(await until(() => units.length === 4)).toBe(true);
		expect(nalTypes(units[3]?.data ?? new Uint8Array())).toEqual([1]);
		expect(units[3]?.data.at(-1)).toBe(2);
		expect(source.stats()).toMatchObject({ restarts: 1, recorders: 2 });
		source.stop();
	});

	test("the recorder is replaced before its time limit", async () => {
		const { procs, units, source } = harness(20);
		procs[0]?.push(KEY);
		expect(await until(() => procs.length === 2)).toBe(true);
		procs[1]?.push(KEY);
		expect(await until(() => procs[0]?.killed() === true)).toBe(true);
		expect(units.length).toBeGreaterThanOrEqual(2);
		source.stop();
	});

	test("a recorder that exits on its own is replaced at once", async () => {
		const { procs, source } = harness();
		procs[0]?.finish(1);
		expect(await until(() => procs.length === 2)).toBe(true);
		source.stop();
	});

	test("a frame cut by an early drain (bytes go on with no start code) asks for a fresh recorder", async () => {
		const { procs, source } = harness();
		procs[0]?.push(KEY.slice(0, 12));
		await Bun.sleep(10);
		procs[0]?.push(KEY.slice(12));
		expect(await until(() => procs.length === 2)).toBe(true);
		expect(source.stats().splitErrors).toBe(1);
		expect(source.stats().idleDrainMs).toBe(2);
		source.stop();
	});

	test("stop kills every recorder and starts no more", async () => {
		const { procs, source } = harness();
		source.requestKeyframe();
		source.stop();
		expect(procs.every((p) => p.killed())).toBe(true);
		await Bun.sleep(10);
		expect(procs).toHaveLength(2);
	});
});
