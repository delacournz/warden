import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { neutralizeInjectState } from "@delacour/warden-core/conditions/inject-state";
import {
	createInjectChannel,
	encodeInjectState,
	INJECT_DYLIB,
	type InjectFs,
	injectAckPath,
	injectLaunchEnv,
	injectStatePath,
	locateInjectDylib,
	parseInjectAck,
	parseInjectState,
	shouldInject,
} from "./inject";

describe("state message", () => {
	test("is always the whole state: offline and clockOffsetMs default to off", () => {
		expect(JSON.parse(encodeInjectState({ seq: 4 }))).toEqual({ seq: 4, offline: false, clockOffsetMs: 0 });
		expect(JSON.parse(encodeInjectState({ seq: 5, offline: true, clockOffsetMs: 1500.9 }))).toEqual({
			seq: 5,
			offline: true,
			clockOffsetMs: 1500,
		});
	});

	test("round-trips and rejects junk", () => {
		const text = encodeInjectState({ seq: 9, offline: true, clockOffsetMs: -86_400_000 });
		expect(parseInjectState(text)).toEqual({ seq: 9, offline: true, clockOffsetMs: -86_400_000 });
		expect(parseInjectState("not json")).toBeUndefined();
		expect(parseInjectState('{"offline":true}')).toBeUndefined();
	});

	test("ack carries the pid and whether the app was launched with a proxy", () => {
		expect(parseInjectAck('{"seq":3,"pid":4242,"proxy":true}')).toEqual({ seq: 3, pid: 4242, proxy: true });
		expect(parseInjectAck('{"seq":3,"pid":4242}')).toEqual({ seq: 3, pid: 4242, proxy: false });
		expect(parseInjectAck('{"seq":3}')).toBeUndefined();
	});

	test("state lives in a per-device directory", () => {
		expect(injectStatePath("/w", "UDID-1")).toBe("/w/inject/UDID-1/state.json");
		expect(injectAckPath("/w/inject/U/state.json")).toBe("/w/inject/U/state.json.ack");
	});
});

describe("release reset (core)", () => {
	test("core's neutral state parses as online on the real clock, with a higher seq", () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-inject-"));
		try {
			const path = injectStatePath(dir, "U1");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, encodeInjectState({ seq: 3, offline: true, clockOffsetMs: 5, clockFrozenMs: 9 }));
			expect(neutralizeInjectState(path)).toBeUndefined();
			expect(parseInjectState(readFileSync(path, "utf8"))).toEqual({ seq: 4, offline: false, clockOffsetMs: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("injectLaunchEnv", () => {
	test("loads the dylib and names the channel; the proxy and clock only when set", () => {
		expect(injectLaunchEnv({ dylib: "/d/lib.dylib", statePath: "/s/state.json" })).toEqual({
			DYLD_INSERT_LIBRARIES: "/d/lib.dylib",
			WARDEN_INJECT_STATE: "/s/state.json",
		});
		expect(
			injectLaunchEnv({
				dylib: "/d/lib.dylib",
				statePath: "/s/state.json",
				proxy: { host: "127.0.0.1", port: 19_081 },
				clockOffsetMs: 3_600_000,
				debug: true,
			})
		).toEqual({
			DYLD_INSERT_LIBRARIES: "/d/lib.dylib",
			WARDEN_INJECT_STATE: "/s/state.json",
			WARDEN_NET_PROXY: "127.0.0.1:19081",
			WARDEN_CLOCK_OFFSET_MS: "3600000",
			WARDEN_INJECT_DEBUG: "1",
		});
	});
});

describe("frozen clock", () => {
	test("clockFrozenMs round-trips and is left out when the clock runs", () => {
		const text = encodeInjectState({ seq: 3, clockFrozenMs: 1_700_000_000_123.9 });
		expect(JSON.parse(text).clockFrozenMs).toBe(1_700_000_000_123);
		expect(parseInjectState(text)?.clockFrozenMs).toBe(1_700_000_000_123);
		expect(JSON.parse(encodeInjectState({ seq: 4 }))).not.toHaveProperty("clockFrozenMs");
		expect(parseInjectState(encodeInjectState({ seq: 4 }))).not.toHaveProperty("clockFrozenMs");
	});

	test("the launch env carries the frozen instant", () => {
		expect(
			injectLaunchEnv({ dylib: "/d", statePath: "/s", clockFrozenMs: 1_700_000_000_000 }).WARDEN_CLOCK_FROZEN_MS
		).toBe("1700000000000");
	});
});

describe("shouldInject", () => {
	test("a launch with no condition and no request stays plain", () => {
		expect(shouldInject({ networkActive: false, clockActive: false, requested: false })).toBe(false);
	});

	test.each([
		{ networkActive: true, clockActive: false, requested: false },
		{ networkActive: false, clockActive: true, requested: false },
		{ networkActive: false, clockActive: false, requested: true },
	])("injects for %o", (input) => {
		expect(shouldInject(input)).toBe(true);
	});
});

describe("locateInjectDylib", () => {
	const base = {
		env: {},
		execPath: "/opt/warden/bin/warden",
		importDir: "/repo/packages/e2e/src/driver/ios",
		wardenHome: "/home/.warden",
		version: "1.2.3",
	};

	test("next to the running warden wins over the source build", () => {
		const found = locateInjectDylib({ ...base, exists: () => true });
		expect(found).toEqual({ success: true, data: `/opt/warden/bin/${INJECT_DYLIB}` });
	});

	test("falls back to native/dist, then the warden home copy", () => {
		const dist = `/repo/packages/e2e/native/dist/${INJECT_DYLIB}`;
		expect(locateInjectDylib({ ...base, exists: (p) => p === dist })).toEqual({ success: true, data: dist });
		const home = `/home/.warden/simd/1.2.3/${INJECT_DYLIB}`;
		expect(locateInjectDylib({ ...base, exists: (p) => p === home })).toEqual({ success: true, data: home });
	});

	test("WARDEN_INJECT_DYLIB that points at nothing is an error, not a fall-through", () => {
		const result = locateInjectDylib({ ...base, env: { WARDEN_INJECT_DYLIB: "/nope" }, exists: (p) => p !== "/nope" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("E_HELPER_MISSING");
			expect(result.error.message).toContain("native:inject");
		}
	});

	test("WARDEN_HELPER_DIR is searched for the dylib too", () => {
		const path = `/helpers/${INJECT_DYLIB}`;
		expect(locateInjectDylib({ ...base, env: { WARDEN_HELPER_DIR: "/helpers" }, exists: (p) => p === path })).toEqual({
			success: true,
			data: path,
		});
	});

	test("nothing found lists what was tried", () => {
		const result = locateInjectDylib({ ...base, exists: () => false });
		expect(result.success).toBe(false);
		if (!result.success)
			expect(result.error.detail).toEqual({ tried: expect.arrayContaining([`/opt/warden/bin/${INJECT_DYLIB}`]) });
	});
});

function memoryFs(alive: Set<number> = new Set()) {
	const files = new Map<string, string>();
	const fs: InjectFs = {
		mkdir: () => undefined,
		writeAtomic: (path, text) => void files.set(path, text),
		read: (path) => files.get(path),
		remove: (path) => void files.delete(path),
		pidAlive: (pid) => alive.has(pid),
	};
	return { fs, files, alive };
}

describe("createInjectChannel", () => {
	function channel(alive: number[] = []) {
		const mem = memoryFs(new Set(alive));
		let t = 1_000;
		const ch = createInjectChannel({
			statePath: "/s/state.json",
			fs: mem.fs,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
		});
		return { ...mem, ch, advance: (ms: number) => (t += ms) };
	}

	test("seq rises on every write, even when the clock does not", () => {
		const { ch } = channel();
		const a = ch.write({ offline: true });
		const b = ch.write({ offline: false });
		expect(b.seq).toBeGreaterThan(a.seq);
		expect(ch.current()).toMatchObject({ seq: b.seq, offline: false });
	});

	test("attached only while the acking pid is alive", () => {
		const { ch, files, alive } = channel([77]);
		expect(ch.attached()).toBeUndefined();
		files.set("/s/state.json.ack", '{"seq":1,"pid":77,"proxy":true}');
		expect(ch.attached()).toEqual({ seq: 1, pid: 77, proxy: true });
		alive.delete(77);
		expect(ch.attached()).toBeUndefined();
	});

	test("acked waits on the injected clock and times out", async () => {
		const { ch, files } = channel([77]);
		const state = ch.write({ offline: true });
		expect(await ch.acked(state.seq, 200)).toBe(false);
		files.set("/s/state.json.ack", JSON.stringify({ seq: state.seq, pid: 77 }));
		expect(await ch.acked(state.seq, 200)).toBe(true);
	});

	test("an ack from a dead process or an older seq does not count", async () => {
		const { ch, files } = channel([]);
		const state = ch.write({});
		files.set("/s/state.json.ack", JSON.stringify({ seq: state.seq, pid: 77 }));
		expect(await ch.acked(state.seq, 100)).toBe(false);
	});

	test("reset forgets the previous app's state and ack", () => {
		const { ch, files } = channel([77]);
		ch.write({ offline: true });
		files.set("/s/state.json.ack", '{"seq":1,"pid":77}');
		ch.reset();
		expect(files.size).toBe(0);
		expect(ch.current().seq).toBe(0);
	});
});
