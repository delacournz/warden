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
	injectA11yPath,
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
			expect(parseInjectState(readFileSync(path, "utf8"))).toEqual({
				seq: 4,
				offline: false,
				clockOffsetMs: 0,
				camera: {},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("release reset of the Keychain ACL shim (core)", () => {
	test("switches the gate of a still-running app off, keeping its generation and sidecar", () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-inject-"));
		try {
			const path = injectStatePath(dir, "U1");
			mkdirSync(dirname(path), { recursive: true });
			const kacl = { enabled: true, generation: 2, itemsPath: "/w/i.json" };
			writeFileSync(path, encodeInjectState({ seq: 3, keychainAcl: kacl }));
			expect(neutralizeInjectState(path)).toBeUndefined();
			expect(parseInjectState(readFileSync(path, "utf8"))?.keychainAcl).toEqual({ ...kacl, enabled: false });
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

describe("keychain acl", () => {
	const kacl = { enabled: true, generation: 2, itemsPath: "/w/inject/U/keychain-acl-items.json" };

	test("the state round-trips; a malformed value is dropped", () => {
		const text = encodeInjectState({ seq: 3, keychainAcl: kacl });
		expect(JSON.parse(text).keychainAcl).toEqual(kacl);
		expect(parseInjectState(text)?.keychainAcl).toEqual(kacl);
		expect(parseInjectState(JSON.stringify({ seq: 1, keychainAcl: { enabled: true } }))?.keychainAcl).toBeUndefined();
		expect(parseInjectState(JSON.stringify({ seq: 1 }))?.keychainAcl).toBeUndefined();
	});

	test("the ack says whether the app was launched with the shim", () => {
		expect(parseInjectAck(JSON.stringify({ seq: 1, pid: 2, keychainAcl: true }))?.keychainAcl).toBe(true);
		expect(parseInjectAck(JSON.stringify({ seq: 1, pid: 2, keychainAcl: false }))?.keychainAcl).toBeUndefined();
	});

	test("the launch env turns the shim on only when asked", () => {
		const base = { dylib: "/d.dylib", statePath: "/s/state.json" };
		expect(injectLaunchEnv({ ...base, keychainAcl: true })).toMatchObject({
			DYLD_INSERT_LIBRARIES: "/d.dylib",
			WARDEN_KEYCHAIN_ACL: "1",
		});
		expect(injectLaunchEnv(base)).not.toHaveProperty("WARDEN_KEYCHAIN_ACL");
	});

	test("the shim alone is a reason to inject", () => {
		const none = { networkActive: false, clockActive: false, requested: false };
		expect(shouldInject({ ...none, keychainAclActive: true })).toBe(true);
		expect(shouldInject({ ...none, keychainAclActive: false })).toBe(false);
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

describe("a11y read request", () => {
	test("is one-shot: only present when asked, and survives the round trip", () => {
		expect(JSON.parse(encodeInjectState({ seq: 4 }))).not.toHaveProperty("dismissKeyboard");
		const dismiss = encodeInjectState({ seq: 5, dismissKeyboard: true });
		expect(JSON.parse(dismiss)).toMatchObject({ seq: 5, dismissKeyboard: true });
		expect(parseInjectState(dismiss)).not.toHaveProperty("dismissKeyboard");
		expect(JSON.parse(encodeInjectState({ seq: 4 }))).not.toHaveProperty("a11yRead");
		const text = encodeInjectState({ seq: 6, a11yRead: true });
		expect(JSON.parse(text)).toMatchObject({ seq: 6, a11yRead: true });
		expect(parseInjectState(text)).toMatchObject({ seq: 6, a11yRead: true });
		expect(parseInjectState(encodeInjectState({ seq: 7 }))).not.toHaveProperty("a11yRead");
	});

	test("the dump sits next to the state file", () => {
		expect(injectA11yPath("/h/inject/u/state.json")).toBe("/h/inject/u/state.json.a11y");
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

	test("the warden home copy is keyed by version: a new warden never loads an older cached dylib", () => {
		const old = `/home/.warden/simd/1.2.2/${INJECT_DYLIB}`;
		const found = locateInjectDylib({ ...base, exists: (p) => p === old });
		expect(found.success).toBe(false);
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
	function channel(alive: number[] = [], bundleId?: string) {
		const mem = memoryFs(new Set(alive));
		let t = 1_000;
		const ch = createInjectChannel({
			statePath: "/s/state.json",
			fs: mem.fs,
			bundleId: () => bundleId,
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

	test("an ack from another app (still alive) is not the app under test", async () => {
		const { ch, files } = channel([77], "com.example");
		files.set("/s/state.json.ack", '{"seq":1,"pid":77,"proxy":true,"bundle":"nz.probe"}');
		expect(ch.attached()).toBeUndefined();
		const state = ch.write({ offline: true });
		files.set("/s/state.json.ack", JSON.stringify({ seq: state.seq, pid: 77, bundle: "nz.probe" }));
		expect(await ch.acked(state.seq, 100)).toBe(false);
		files.set("/s/state.json.ack", JSON.stringify({ seq: state.seq, pid: 77, bundle: "com.example" }));
		expect(ch.attached()).toEqual({ seq: state.seq, pid: 77, proxy: false, bundleId: "com.example" });
		expect(await ch.acked(state.seq, 100)).toBe(true);
	});

	test("with no bundle known, or an ack without one, any live app counts", () => {
		const { ch, files } = channel([77]);
		files.set("/s/state.json.ack", '{"seq":1,"pid":77,"bundle":"nz.probe"}');
		expect(ch.attached()?.pid).toBe(77);
		const known = channel([77], "com.example");
		known.files.set("/s/state.json.ack", '{"seq":1,"pid":77}');
		expect(known.ch.attached()?.pid).toBe(77);
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

describe("camera", () => {
	const feeds = {
		back: { kind: "image" as const, path: "/w/camera/U1/back-aaa.png" },
		front: { kind: "video" as const, path: "/w/camera/U1/front-bbb.mp4", loop: false },
	};

	test("the state carries the feeds and round-trips them; no camera key without feeds", () => {
		const text = encodeInjectState({ seq: 3, camera: feeds });
		expect(JSON.parse(text).camera).toEqual(feeds);
		expect(parseInjectState(text)?.camera).toEqual(feeds);
		expect(JSON.parse(encodeInjectState({ seq: 4 }))).not.toHaveProperty("camera");
		expect(parseInjectState(encodeInjectState({ seq: 4 }))?.camera).toBeUndefined();
	});

	test("junk feeds are dropped, not passed to the dylib", () => {
		const parsed = parseInjectState(
			JSON.stringify({ seq: 1, camera: { back: { kind: "gif", path: "/x" }, front: { kind: "image" } } })
		);
		expect(parsed?.camera).toEqual({});
	});

	test("the ack says whether the app was launched with the camera", () => {
		expect(parseInjectAck(JSON.stringify({ seq: 1, pid: 2, camera: true }))?.camera).toBe(true);
		expect(parseInjectAck(JSON.stringify({ seq: 1, pid: 2 }))?.camera).toBeUndefined();
	});

	test("the launch env turns the camera on only when asked", () => {
		expect(injectLaunchEnv({ dylib: "/d", statePath: "/s", camera: true }).WARDEN_CAMERA).toBe("1");
		expect(injectLaunchEnv({ dylib: "/d", statePath: "/s" })).not.toHaveProperty("WARDEN_CAMERA");
	});

	test("a camera feed alone is a reason to inject", () => {
		expect(shouldInject({ networkActive: false, clockActive: false, cameraActive: true, requested: false })).toBe(true);
	});

	test("core's neutral state takes every feed off", () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-inject-cam-"));
		const path = join(dir, "state.json");
		writeFileSync(path, encodeInjectState({ seq: 5, camera: feeds }));
		expect(neutralizeInjectState(path)).toBeUndefined();
		expect(parseInjectState(readFileSync(path, "utf8"))?.camera).toEqual({});
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("keyboard", () => {
	test("the state carries the mode and round-trips it; no key without one", () => {
		expect(parseInjectState(encodeInjectState({ seq: 1, keyboard: "hardware" }))?.keyboard).toBe("hardware");
		expect(JSON.parse(encodeInjectState({ seq: 1 }))).not.toHaveProperty("keyboard");
		expect(parseInjectState('{"seq":1,"keyboard":"both"}')?.keyboard).toBeUndefined();
	});

	test("the launch env names the initial mode only when given", () => {
		const base = { dylib: "/d.dylib", statePath: "/s/state.json" };
		expect(injectLaunchEnv({ ...base, keyboard: "software" }).WARDEN_KEYBOARD).toBe("software");
		expect(injectLaunchEnv({ ...base, keyboard: "hardware" }).WARDEN_KEYBOARD).toBe("hardware");
		expect(injectLaunchEnv(base)).not.toHaveProperty("WARDEN_KEYBOARD");
	});

	test("the keyboard mode is a reason to inject", () => {
		expect(shouldInject({ networkActive: false, clockActive: false, keyboardActive: true, requested: false })).toBe(
			true
		);
	});

	test("a write that names no mode keeps the one on disk (network, clock and a11y writes are whole states)", () => {
		const mem = memoryFs(new Set());
		const ch = createInjectChannel({ statePath: "/s/state.json", fs: mem.fs, now: () => 1_000, sleep: async () => {} });
		ch.write({ keyboard: "hardware" });
		ch.write({ offline: true });
		expect(ch.current().keyboard).toBe("hardware");
		expect(ch.current().offline).toBe(true);
		ch.write({ keyboard: "software" });
		expect(ch.current().keyboard).toBe("software");
	});

	test("reset forgets the app but keeps the mode for the next launch", () => {
		const mem = memoryFs(new Set([77]));
		const ch = createInjectChannel({ statePath: "/s/state.json", fs: mem.fs, now: () => 1_000, sleep: async () => {} });
		ch.write({ keyboard: "hardware", offline: true });
		mem.files.set("/s/state.json.ack", '{"seq":1,"pid":77}');
		ch.reset();
		expect(mem.files.has("/s/state.json.ack")).toBe(false);
		expect(ch.current().keyboard).toBe("hardware");
		expect(ch.current().offline).toBe(false);
	});

	test("core's release reset keeps the mode for other areas and puts software back for the keyboard area", () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-inject-kbd-"));
		const path = join(dir, "state.json");
		writeFileSync(path, encodeInjectState({ seq: 5, offline: true, keyboard: "hardware" }));
		expect(neutralizeInjectState(path, "network")).toBeUndefined();
		expect(parseInjectState(readFileSync(path, "utf8"))).toMatchObject({
			seq: 6,
			offline: false,
			keyboard: "hardware",
		});
		expect(neutralizeInjectState(path, "keyboard")).toBeUndefined();
		expect(parseInjectState(readFileSync(path, "utf8"))).toMatchObject({ seq: 7, keyboard: "software" });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("passkeys", () => {
	const passkeys = { mode: "cancel" as const, uv: "skip" as const, storePath: "/w/passkeys/U1/store.json" };

	test("the state carries mode, uv and the store path and round-trips them; no key when off", () => {
		const text = encodeInjectState({ seq: 3, passkeys });
		expect(JSON.parse(text).passkeys).toEqual(passkeys);
		expect(parseInjectState(text)?.passkeys).toEqual(passkeys);
		expect(JSON.parse(encodeInjectState({ seq: 4 }))).not.toHaveProperty("passkeys");
		expect(parseInjectState(encodeInjectState({ seq: 4 }))?.passkeys).toBeUndefined();
	});

	test("a malformed passkeys object is dropped, not passed to the dylib", () => {
		for (const bad of [{ mode: "bogus", uv: "match", storePath: "/s" }, { mode: "auto", uv: "match" }, "on", null]) {
			expect(parseInjectState(JSON.stringify({ seq: 1, passkeys: bad }))?.passkeys).toBeUndefined();
		}
	});

	test("the ack says whether the app was launched with the authenticator", () => {
		expect(parseInjectAck(JSON.stringify({ seq: 1, pid: 2, passkeys: true }))?.passkeys).toBe(true);
		expect(parseInjectAck(JSON.stringify({ seq: 1, pid: 2, passkeys: false }))?.passkeys).toBeUndefined();
		expect(parseInjectAck(JSON.stringify({ seq: 1, pid: 2 }))?.passkeys).toBeUndefined();
	});

	test("the launch env turns the authenticator on only when asked", () => {
		expect(injectLaunchEnv({ dylib: "/d", statePath: "/s", passkeys: true }).WARDEN_PASSKEYS).toBe("1");
		expect(injectLaunchEnv({ dylib: "/d", statePath: "/s" })).not.toHaveProperty("WARDEN_PASSKEYS");
	});

	test("an enabled authenticator alone is a reason to inject", () => {
		expect(shouldInject({ networkActive: false, clockActive: false, passkeysActive: true, requested: false })).toBe(
			true
		);
	});

	test("core's neutral state keeps the authenticator, except when the reset area is passkeys", () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-inject-pk-"));
		const path = join(dir, "state.json");
		writeFileSync(path, encodeInjectState({ seq: 5, passkeys }));
		expect(neutralizeInjectState(path, "network")).toBeUndefined();
		expect(parseInjectState(readFileSync(path, "utf8"))?.passkeys).toEqual(passkeys);
		expect(neutralizeInjectState(path, "passkeys")).toBeUndefined();
		expect(parseInjectState(readFileSync(path, "utf8"))?.passkeys).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});
