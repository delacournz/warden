import { describe, expect, test } from "bun:test";
import { mayBeRecorded, processCommand, safeToSignal } from "./process-identity";

const alive = () => true;
const dead = () => false;

describe("processCommand", () => {
	test("reads a live process's full command line; a pid that is gone reads as undefined", async () => {
		const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			let command: string | undefined;
			for (let n = 0; n < 50 && command === undefined; n += 1) {
				command = processCommand(child.pid);
				if (command === undefined) await Bun.sleep(10);
			}
			expect(command).toContain("sleep 30");
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
		expect(processCommand(child.pid)).toBeUndefined();
	});
});

describe("safeToSignal / mayBeRecorded (14-4)", () => {
	const marks = ["--udid U1", "--socket /s.sock"];
	const helper = () => "/opt/warden-simd --udid U1 --socket /s.sock --idle-timeout 600";
	const other = () => "/usr/bin/vim notes.txt";
	const unreadable = () => undefined;

	test("a live pid whose command line carries every mark is ours: signal it", () => {
		expect(safeToSignal({ pidAlive: alive, command: helper }, 7, marks)).toBe(true);
		expect(mayBeRecorded({ pidAlive: alive, command: helper }, 7, marks)).toBe(true);
	});

	test("a pid reused by another process is neither signalled nor counted as the recorded one", () => {
		expect(safeToSignal({ pidAlive: alive, command: other }, 7, marks)).toBe(false);
		expect(mayBeRecorded({ pidAlive: alive, command: other }, 7, marks)).toBe(false);
		expect(
			safeToSignal({ pidAlive: alive, command: () => "/opt/warden-simd --udid U2 --socket /s.sock" }, 7, marks)
		).toBe(false);
	});

	test("an unreadable command line: no signal, but the pid may still be ours (never start a second one beside it)", () => {
		expect(safeToSignal({ pidAlive: alive, command: unreadable }, 7, marks)).toBe(false);
		expect(mayBeRecorded({ pidAlive: alive, command: unreadable }, 7, marks)).toBe(true);
	});

	test("a dead pid is neither; without a command reader (test fakes) liveness alone decides", () => {
		expect(safeToSignal({ pidAlive: dead, command: helper }, 7, marks)).toBe(false);
		expect(mayBeRecorded({ pidAlive: dead, command: helper }, 7, marks)).toBe(false);
		expect(safeToSignal({ pidAlive: alive }, 7, marks)).toBe(true);
		expect(mayBeRecorded({ pidAlive: alive }, 7, marks)).toBe(true);
	});
});
