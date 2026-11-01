import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { processCommand, processIdentity } from "./process-identity";

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

	test.skipIf(!existsSync("/proc/self/cmdline"))(
		"a `ps` that exits non-zero falls through to /proc/<pid>/cmdline instead of reading as unknown (S2)",
		async () => {
			const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
			try {
				expect(processIdentity.commandVia(["/bin/false"])(child.pid)).toContain("sleep 30");
			} finally {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	);

	test("does not depend on PATH: a caller with no `ps` on its PATH still reads command lines", () => {
		const script = `import { processCommand } from ${JSON.stringify(`${import.meta.dir}/process-identity.ts`)}; console.log(processCommand(process.pid) ?? "undefined");`;
		const run = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/nonexistent" }, stdout: "pipe" });
		expect(run.stdout.toString().trim()).not.toBe("undefined");
		expect(run.stdout.toString()).toContain(process.execPath);
	});
});

describe("recordedIdentity", () => {
	const marks = ["--udid U1"];
	test("gone, match, mismatch or unknown; without a command reader a live pid matches", () => {
		expect(processIdentity.recordedIdentity({ pidAlive: dead, command: () => "x --udid U1" }, 7, marks)).toBe("gone");
		expect(processIdentity.recordedIdentity({ pidAlive: alive, command: () => "x --udid U1" }, 7, marks)).toBe("match");
		expect(processIdentity.recordedIdentity({ pidAlive: alive, command: () => "vim" }, 7, marks)).toBe("mismatch");
		expect(processIdentity.recordedIdentity({ pidAlive: alive, command: () => undefined }, 7, marks)).toBe("unknown");
		expect(processIdentity.recordedIdentity({ pidAlive: alive }, 7, marks)).toBe("match");
	});
});

describe("safeToSignal / mayBeRecorded (14-4)", () => {
	const marks = ["--udid U1", "--socket /s.sock"];
	const helper = () => "/opt/warden-simd --udid U1 --socket /s.sock --idle-timeout 600";
	const other = () => "/usr/bin/vim notes.txt";
	const unreadable = () => undefined;

	test("a live pid whose command line carries every mark is ours: signal it", () => {
		expect(processIdentity.safeToSignal({ pidAlive: alive, command: helper }, 7, marks)).toBe(true);
		expect(processIdentity.mayBeRecorded({ pidAlive: alive, command: helper }, 7, marks)).toBe(true);
	});

	test("a pid reused by another process is neither signalled nor counted as the recorded one", () => {
		expect(processIdentity.safeToSignal({ pidAlive: alive, command: other }, 7, marks)).toBe(false);
		expect(processIdentity.mayBeRecorded({ pidAlive: alive, command: other }, 7, marks)).toBe(false);
		expect(
			processIdentity.safeToSignal(
				{ pidAlive: alive, command: () => "/opt/warden-simd --udid U2 --socket /s.sock" },
				7,
				marks
			)
		).toBe(false);
	});

	test("an unreadable command line: no signal, but the pid may still be ours (never start a second one beside it)", () => {
		expect(processIdentity.safeToSignal({ pidAlive: alive, command: unreadable }, 7, marks)).toBe(false);
		expect(processIdentity.mayBeRecorded({ pidAlive: alive, command: unreadable }, 7, marks)).toBe(true);
	});

	test("a dead pid is neither; without a command reader (test fakes) liveness alone decides", () => {
		expect(processIdentity.safeToSignal({ pidAlive: dead, command: helper }, 7, marks)).toBe(false);
		expect(processIdentity.mayBeRecorded({ pidAlive: dead, command: helper }, 7, marks)).toBe(false);
		expect(processIdentity.safeToSignal({ pidAlive: alive }, 7, marks)).toBe(true);
		expect(processIdentity.mayBeRecorded({ pidAlive: alive }, 7, marks)).toBe(true);
	});
});
