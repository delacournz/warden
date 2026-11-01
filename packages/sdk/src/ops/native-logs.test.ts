import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-runtime/exec";
import { nativeLogOps } from "./native-logs";
import { refStores } from "./ref-store";
import type { OpSession } from "./session";
import { stateStores } from "./state-store";

const NOW = Date.parse("2026-10-25T12:00:00.000+13:00");

const iosLine = (time: string, type: string, message: string): string =>
	JSON.stringify({ timestamp: `2026-10-25 ${time}+1300`, messageType: type, eventMessage: message });

type Rig = { session: OpSession; calls: string[] };

function rig(
	platform: "ios" | "android",
	replies: (cmd: string) => ExecResult | undefined,
	app: string | null = "com.example.app"
): Rig {
	const calls: string[] = [];
	const state = stateStores.createMemoryStateStore();
	if (app !== null) state.update((s) => ({ ...s, app }));
	const session: OpSession = {
		device: { id: "UDID", platform },
		host: {
			env: {},
			cwd: "/tmp",
			home: "/tmp",
			now: () => NOW,
			exec: async (cmd) => {
				const line = cmd.join(" ");
				calls.push(line);
				return replies(line) ?? { exitCode: 0, stdout: "", stderr: "" };
			},
			sleep: async () => undefined,
		},
		driver: async () => ({ success: false, error: { code: "engine_unavailable", message: "none" } }),
		refs: refStores.createMemoryRefStore(),
		state,
		timeoutMs: 100,
	};
	return { session, calls };
}

const iosReplies =
	(log: string) =>
	(cmd: string): ExecResult | undefined => {
		if (cmd.includes("get_app_container")) return { exitCode: 0, stdout: "/x/Example.app\n", stderr: "" };
		if (cmd.startsWith("plutil")) return { exitCode: 0, stdout: "Example\n", stderr: "" };
		if (cmd.includes("log show")) return { exitCode: 0, stdout: log, stderr: "" };
		return undefined;
	};

describe("line parsers", () => {
	test("iOS ndjson: timestamp, level and message; headers and torn lines are dropped", () => {
		expect(nativeLogOps.parseIosLine(iosLine("12:00:00.123456", "Error", "boom"))).toEqual({
			ts: Date.parse("2026-10-25T12:00:00.123+13:00"),
			level: "error",
			text: "boom",
		});
		expect(nativeLogOps.parseIosLine(iosLine("12:00:00.5", "Default", "hi"))?.level).toBe("info");
		expect(nativeLogOps.parseIosLine('{"count":3}')).toBeUndefined();
		expect(nativeLogOps.parseIosLine('{"timestamp":')).toBeUndefined();
	});

	test("Android threadtime + epoch", () => {
		expect(nativeLogOps.parseAndroidLine("1761346800.250  1234  1250 W ReactNative: slow frame")).toEqual({
			ts: 1761346800250,
			level: "warn",
			text: "ReactNative: slow frame",
		});
		expect(nativeLogOps.parseAndroidLine("--------- beginning of main")).toBeUndefined();
	});
});

describe("nativeLogs op", () => {
	test("iOS: reads the app process's window, oldest first, filtered by level", async () => {
		const log = [
			iosLine("11:59:50.000", "Info", "started"),
			iosLine("11:59:58.000", "Error", "crashed"),
			iosLine("11:59:40.000", "Debug", "noise"),
		].join("\n");
		const { session, calls } = rig("ios", iosReplies(log));
		const done = await nativeLogOps.nativeLogs(session, { since: NOW - 30_000, level: "info" });
		expect(done.success && done.data.result.lines.map((l) => l.text)).toEqual(["started", "crashed"]);
		const show = calls.find((c) => c.includes("log show"));
		expect(show).toContain("--last 30s");
		expect(show).toContain('process == "Example"');
	});

	test("limit keeps the newest lines", async () => {
		const log = [iosLine("11:59:50.000", "Info", "a"), iosLine("11:59:51.000", "Info", "b")].join("\n");
		const { session } = rig("ios", iosReplies(log));
		const done = await nativeLogOps.nativeLogs(session, { limit: 1 });
		expect(done.success && done.data.result.lines.map((l) => l.text)).toEqual(["b"]);
	});

	test("Android: logcat for the app's pid", async () => {
		const { session, calls } = rig("android", (cmd) => {
			if (cmd.includes("pidof")) return { exitCode: 0, stdout: "4242\n", stderr: "" };
			if (cmd.includes("logcat")) {
				return { exitCode: 0, stdout: `${(NOW - 5000) / 1000}  4242  4242 E App: failed\n`, stderr: "" };
			}
			return undefined;
		});
		const done = await nativeLogOps.nativeLogs(session, {});
		expect(done.success && done.data.result.lines).toEqual([{ ts: NOW - 5000, level: "error", text: "App: failed" }]);
		expect(calls.find((c) => c.includes("logcat"))).toContain("--pid=4242");
	});

	test("no app opened is a usage error; a failing log show is a failure", async () => {
		const none = await nativeLogOps.nativeLogs(rig("ios", () => undefined, null).session, {});
		expect(!none.success && none.error.code).toBe("usage");
		const failing = await nativeLogOps.nativeLogs(
			rig("ios", (cmd) =>
				cmd.includes("log show") ? { exitCode: 1, stdout: "", stderr: "denied\n" } : iosReplies("")(cmd)
			).session,
			{}
		);
		expect(!failing.success && failing.error.message).toContain("log show: exit 1 denied");
	});
});

describe("followNativeLogs", () => {
	test("yields new lines once across polls and ends when the signal aborts", async () => {
		const first = iosLine("11:59:58.000", "Info", "one");
		const second = iosLine("11:59:59.000", "Info", "two");
		let polls = 0;
		const controller = new AbortController();
		const { session } = rig("ios", (cmd) => {
			if (!cmd.includes("log show")) return iosReplies("")(cmd);
			polls += 1;
			if (polls >= 3) controller.abort();
			return { exitCode: 0, stdout: polls === 1 ? first : `${first}\n${second}`, stderr: "" };
		});
		const seen: string[] = [];
		for await (const batch of nativeLogOps.followNativeLogs(session, {}, controller.signal)) {
			if (!batch.success) throw new Error(batch.error.message);
			seen.push(...batch.data.map((l) => l.text));
		}
		expect(seen).toEqual(["one", "two"]);
	});

	test("a failed read is yielded once and ends the stream", async () => {
		const { session } = rig("ios", (cmd) =>
			cmd.includes("log show") ? { exitCode: 2, stdout: "", stderr: "gone" } : iosReplies("")(cmd)
		);
		const out: boolean[] = [];
		for await (const batch of nativeLogOps.followNativeLogs(session, {}, undefined)) out.push(batch.success);
		expect(out).toEqual([false]);
	});
});
