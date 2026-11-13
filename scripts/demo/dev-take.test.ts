import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevBeat } from "./demo.types";
import { applyEdit, type BeatIo, rawRecordArgv, runBeats, scriptArgv, stopRecording } from "./dev-take";

const beat = (id: string, o: Partial<DevBeat> = {}): DevBeat => ({
	id,
	caption: id,
	timeoutMs: 200,
	pauseAfterMs: 10,
	...o,
});

function fakeIo(frames: string[][]): { io: BeatIo; log: string[]; clock: { t: number } } {
	const clock = { t: 0 };
	const log: string[] = [];
	let i = 0;
	const io: BeatIo = {
		frame: () => frames[Math.min(i, frames.length - 1)] ?? [],
		keys: (t) => log.push(`keys:${t}`),
		phoneWait: async (s) => {
			log.push(`phone:${s.join(",")}`);
		},
		edit: async (e) => {
			log.push(`edit:${e.file}`);
		},
		stopVideo: async () => {
			log.push("stopVideo");
		},
		now: () => clock.t,
		sleep: async (ms) => {
			clock.t += ms / 1000;
			i += 1;
		},
	};
	return { io, log, clock };
}

describe("runBeats", () => {
	test("beatDone runs after a beat is recorded and holds the next beat until it resolves", async () => {
		const { io, log, clock } = fakeIo([["x"]]);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		io.beatDone = async (b) => {
			log.push(`done:${b.id}`);
			if (b.id === "a") await gate;
		};
		const run = runBeats([beat("a"), beat("b", { keys: "q" })], io);
		await Bun.sleep(20);
		expect(log).toEqual(["done:a"]);
		clock.t += 5;
		release();
		const beats = await run;
		expect(log).toEqual(["done:a", "keys:q", "done:b"]);
		expect(beats[1]?.startS).toBeGreaterThanOrEqual(5);
	});

	test("waits for the screen, then the phone, then acts, then waits for the effect", async () => {
		const { io, log } = fakeIo([["booting"], ["booting"], ["✓ dev client"]]);
		const beats = await runBeats(
			[
				beat("hmr", {
					waitScreen: "✓ dev client",
					waitPhone: ["id=a"],
					edit: { file: "f.tsx", from: "x", to: "y" },
					afterPhone: ["text=y"],
				}),
				beat("quit", { keys: "q" }),
			],
			io
		);
		expect(log).toEqual(["phone:id=a", "edit:f.tsx", "phone:text=y", "keys:q"]);
		expect(beats.map((b) => b.id)).toEqual(["hmr", "quit"]);
		const first = beats[0];
		expect(first && first.readyS >= first.startS && first.endS >= first.readyS).toBe(true);
	});
	test("stops the video before an action that ends the lease", async () => {
		const { io, log } = fakeIo([[]]);
		await runBeats([beat("quit", { keys: "q", stopVideoFirst: true })], io);
		expect(log).toEqual(["stopVideo", "keys:q"]);
	});
	test("a screen that never matches fails with the frame", async () => {
		const { io } = fakeIo([["stuck here"]]);
		await expect(runBeats([beat("a", { waitScreen: "never" })], io)).rejects.toThrow("stuck here");
	});
});

describe("applyEdit", () => {
	test("edits once and restores byte for byte", async () => {
		const dir = await mkdtemp(join(tmpdir(), "edit-"));
		const file = join(dir, "a.tsx");
		await writeFile(file, 'body: "hello"\n');
		const restore = await applyEdit(file, { from: "hello", to: "world" });
		expect(await readFile(file, "utf8")).toBe('body: "world"\n');
		await restore();
		expect(await readFile(file, "utf8")).toBe('body: "hello"\n');
	});
	test("a missing anchor throws and leaves the file alone", async () => {
		const dir = await mkdtemp(join(tmpdir(), "edit-"));
		const file = join(dir, "a.tsx");
		await writeFile(file, "x");
		await expect(applyEdit(file, { from: "nope", to: "y" })).rejects.toThrow("does not contain");
		expect(await readFile(file, "utf8")).toBe("x");
	});
});

describe("stopRecording", () => {
	test("warden stops it: nothing is killed", async () => {
		const sh: string[][] = [];
		const out = await stopRecording(
			async () => ({ code: 0, stdout: "", stderr: "" }),
			async (c) => {
				sh.push([...c]);
				return { code: 0 };
			},
			"U",
			"/w/take.mp4"
		);
		expect(out).toBe("stopped");
		expect(sh).toEqual([]);
	});
	test("failure path: warden refuses (lease gone) so the recordVideo child is interrupted", async () => {
		const sh: string[][] = [];
		const out = await stopRecording(
			async () => ({ code: 2, stdout: "", stderr: "is not leased" }),
			async (c) => {
				sh.push([...c]);
				return { code: 0 };
			},
			"U",
			"/w/take.mp4"
		);
		expect(out).toBe("killed");
		expect(sh).toEqual([["pkill", "-INT", "-f", "simctl io U recordVideo.*/w/take.mp4"]]);
	});
	test("warden itself throwing is the same failure path", async () => {
		const sh: string[][] = [];
		const out = await stopRecording(
			async () => {
				throw new Error("spawn failed");
			},
			async (c) => {
				sh.push([...c]);
				return { code: 0 };
			},
			"U",
			"f"
		);
		expect(out).toBe("killed");
		expect(sh).toHaveLength(1);
	});
});

describe("scriptArgv", () => {
	test("defines warden as this checkout's CLI and fills in the label", () => {
		const argv = scriptArgv("warden claim ios --label {label}", "demo-x", ["bun", "/repo/apps/cli/src/cli.ts"]);
		expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
		expect(argv[2]).toContain('warden() { bun /repo/apps/cli/src/cli.ts "$@"; }');
		expect(argv[2]).toContain("warden claim ios --label demo-x");
	});
});

describe("waitBoot beat", () => {
	test("waits for the simulator to finish booting before the action", async () => {
		const { io, log } = fakeIo([["x"]]);
		io.waitBoot = async () => {
			log.push("boot");
		};
		await runBeats([beat("a", { waitBoot: true, keys: "k" })], io);
		expect(log).toEqual(["boot", "keys:k"]);
	});
});

describe("raw simctl video", () => {
	test("starts recordVideo in the background so warden's helper never attaches to the device", () => {
		const argv = rawRecordArgv("U", "/w/take.mp4");
		expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
		expect(argv[2]).toContain("xcrun simctl io U recordVideo");
		expect(argv[2]).toContain("'/w/take.mp4'");
		expect(argv[2]?.trimEnd().endsWith("&")).toBe(true);
	});
	test("raw stop interrupts the child without asking warden, then waits for the file", async () => {
		const sh: string[][] = [];
		let asked = 0;
		const out = await stopRecording(
			async () => {
				asked += 1;
				return { code: 0, stdout: "", stderr: "" };
			},
			async (c) => {
				sh.push([...c]);
				return { code: 0 };
			},
			"U",
			"/w/take.mp4",
			true
		);
		expect(out).toBe("killed");
		expect(asked).toBe(0);
		expect(sh).toEqual([
			["pkill", "-INT", "-f", "simctl io U recordVideo.*/w/take.mp4"],
			["sleep", "2"],
		]);
	});
});
