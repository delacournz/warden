import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	aliveArgv,
	killArgv,
	parsePerfettoPid,
	perfettoStartArgv,
	pullArgv,
	remoteSimpleperfPath,
	remoteTracePath,
	simpleperfStartArgv,
} from "./capture";

const adb = { adb: "adb", serial: "emulator-5554" };
const fixture = (n: string) => readFileSync(join(import.meta.dir, "../../fixtures", n), "utf8");

describe("capture argv", () => {
	test("perfetto reads its config from stdin and daemonizes", () => {
		expect(perfettoStartArgv(adb, remoteTracePath(7)).join(" ")).toBe(
			"adb -s emulator-5554 shell perfetto --txt -c - --background-wait -o /data/misc/perfetto-traces/warden-7.pftrace"
		);
	});

	test("simpleperf is detached, pid-scoped, duration-capped and prints its pid", () => {
		const argv = simpleperfStartArgv(adb, 4242, remoteSimpleperfPath(9), 30_000);
		expect(argv.slice(0, 4)).toEqual(["adb", "-s", "emulator-5554", "shell"]);
		expect(argv[4]).toBe(
			"nohup simpleperf record -e cpu-clock:u -f 4000 -p 4242 --duration 30 -o /data/local/tmp/warden-9.data >/dev/null 2>&1 & echo $!"
		);
	});

	test("kill, liveness and pull", () => {
		expect(killArgv(adb, 5, "TERM").slice(4)).toEqual(["kill", "-TERM", "5"]);
		expect(aliveArgv(adb, 5).slice(4)).toEqual(["test", "-d", "/proc/5"]);
		expect(pullArgv(adb, "/r", "/l").slice(2)).toEqual(["emulator-5554", "pull", "/r", "/l"]);
	});
});

describe("parsePerfettoPid", () => {
	test("reads the pid line", () => {
		expect(parsePerfettoPid(fixture("perfetto-start-output.txt"))).toBe(12345);
	});
	test("ignores chatter and fails on none", () => {
		expect(parsePerfettoPid("[1.0] some log\n  4321 \n")).toBe(4321);
		expect(parsePerfettoPid("perfetto: error\n")).toBeUndefined();
	});
});
