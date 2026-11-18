import { describe, expect, test } from "bun:test";
import { driverErr } from "../errors";
import { createInjectChannel, type InjectFs } from "./inject";
import {
	createIosKeychainAcl,
	KEYCHAIN_ACL_GENERATION_FILE,
	KEYCHAIN_ACL_ITEMS_FILE,
	rawLaunchKeychainAcl,
} from "./ios-keychain-acl";

const DIR = "/w/inject/U1";
const STATE = `${DIR}/state.json`;
const ACK = `${STATE}.ack`;

/** An in-memory inject dir; `app` = what the running injected app was launched with (it acks every state write). */
function rig(app?: { keychainAcl: boolean; silent?: boolean }) {
	const files = new Map<string, string>();
	const fs: InjectFs = {
		mkdir: () => undefined,
		writeAtomic: (path, text) => {
			files.set(path, text);
			if (path === STATE && app && !app.silent) {
				const seq = (JSON.parse(text) as { seq: number }).seq;
				files.set(ACK, JSON.stringify({ seq, pid: 7, keychainAcl: app.keychainAcl }));
			}
		},
		read: (path) => files.get(path),
		remove: (path) => void files.delete(path),
		pidAlive: () => true,
	};
	if (app) files.set(ACK, JSON.stringify({ seq: 0, pid: 7, keychainAcl: app.keychainAcl }));
	let t = 0;
	const channel = createInjectChannel({
		statePath: STATE,
		fs,
		now: () => (t += 1),
		sleep: async (ms) => {
			t += ms;
		},
	});
	const make = () => createIosKeychainAcl({ channel, fs, ackMs: 100 });
	const kacl = make();
	const writeState = () => channel.write({ ...(kacl.state() ? { keychainAcl: kacl.state() } : {}) });
	return { files, fs, channel, kacl, make, writeState };
}

describe("ios keychain acl", () => {
	test("off by default: no state key, generation 0", async () => {
		const r = rig();
		expect(r.kacl.on()).toBe(false);
		expect(r.kacl.state()).toBeUndefined();
		expect(await r.kacl.run({ kind: "status" }, r.writeState)).toEqual({
			success: true,
			data: { enabled: false, generation: 0 },
		});
	});

	test("on with no injected app is staged for the next launch", async () => {
		const r = rig();
		const on = await r.kacl.run({ kind: "on" }, r.writeState);
		expect(on).toEqual({ success: true, data: { enabled: true, generation: 0, appliesOnLaunch: true } });
		expect(r.kacl.on()).toBe(true);
		expect(JSON.parse(r.files.get(STATE) ?? "{}").keychainAcl).toEqual({
			enabled: true,
			generation: 0,
			itemsPath: `${DIR}/${KEYCHAIN_ACL_ITEMS_FILE}`,
		});
	});

	test("an app launched with the shim takes on / off live and acks it", async () => {
		const r = rig({ keychainAcl: true });
		expect(await r.kacl.run({ kind: "on" }, r.writeState)).toEqual({
			success: true,
			data: { enabled: true, generation: 0 },
		});
		expect(await r.kacl.run({ kind: "off" }, r.writeState)).toEqual({
			success: true,
			data: { enabled: false, generation: 0 },
		});
		expect(JSON.parse(r.files.get(STATE) ?? "{}").keychainAcl.enabled).toBe(false);
	});

	test("an app launched without the shim gets it from the next launch", async () => {
		const r = rig({ keychainAcl: false });
		const on = await r.kacl.run({ kind: "on" }, r.writeState);
		expect(on.success && on.data.appliesOnLaunch).toBe(true);
	});

	test("an app that does not ack is E_TIMEOUT and the switch is undone", async () => {
		const r = rig({ keychainAcl: true, silent: true });
		const on = await r.kacl.run({ kind: "on" }, r.writeState);
		expect(!on.success && on.error.code).toBe("E_TIMEOUT");
		expect(r.kacl.on()).toBe(false);
	});

	test("a new driver on the same lease keeps the switch (state file) and the generation (host file)", async () => {
		const r = rig();
		await r.kacl.run({ kind: "on" }, r.writeState);
		r.files.set(`${DIR}/${KEYCHAIN_ACL_GENERATION_FILE}`, JSON.stringify({ generation: 3 }));
		const again = r.make();
		expect(again.on()).toBe(true);
		expect(again.state()?.generation).toBe(3);
	});

	test("the generation survives the state reset every launch does", async () => {
		const r = rig();
		await r.kacl.run({ kind: "on" }, r.writeState);
		r.files.set(`${DIR}/${KEYCHAIN_ACL_GENERATION_FILE}`, JSON.stringify({ generation: 5 }));
		r.channel.reset();
		expect(r.kacl.state()?.generation).toBe(5);
		expect(r.make().state()).toBeUndefined();
	});
});

describe("ios keychain acl: re-enrolment generation", () => {
	const GEN = `${DIR}/${KEYCHAIN_ACL_GENERATION_FILE}`;

	test("bump with the shim on: +1 in the host file and the state, and a later driver reads it", async () => {
		const r = rig();
		await r.kacl.run({ kind: "on" }, r.writeState);
		expect(await r.kacl.bump(r.writeState)).toBe(1);
		expect(JSON.parse(r.files.get(GEN) ?? "{}")).toEqual({ generation: 1 });
		expect(JSON.parse(r.files.get(STATE) ?? "{}").keychainAcl.generation).toBe(1);
		expect(await r.kacl.bump(r.writeState)).toBe(2);
		const later = r.make();
		expect(later.state()?.generation).toBe(2);
	});

	test("bump with the shim off: undefined, nothing written", async () => {
		const r = rig();
		expect(await r.kacl.bump(r.writeState)).toBeUndefined();
		expect(r.files.has(GEN)).toBe(false);
		expect(r.files.has(STATE)).toBe(false);
	});

	test("a running injected app acknowledges the new generation before bump answers", async () => {
		const r = rig({ keychainAcl: true });
		await r.kacl.run({ kind: "on" }, r.writeState);
		expect(await r.kacl.bump(r.writeState)).toBe(1);
		const ack = JSON.parse(r.files.get(ACK) ?? "{}") as { seq: number };
		expect(ack.seq).toBe(JSON.parse(r.files.get(STATE) ?? "{}").seq);
	});
});

describe("rawLaunchKeychainAcl (a launch that bypasses the driver)", () => {
	const dylib = () => ({ success: true as const, data: "/opt/libwarden-inject.dylib" });

	test("on: the switch is written into the state (other keys kept) and the SIMCTL_CHILD_ env loads the dylib", () => {
		const r = rig();
		r.channel.write({ keyboard: "software" });
		const got = rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: true, dylib });
		expect(got).toEqual({
			success: true,
			data: {
				enabled: true,
				env: {
					SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: "/opt/libwarden-inject.dylib",
					SIMCTL_CHILD_WARDEN_INJECT_STATE: STATE,
					SIMCTL_CHILD_WARDEN_KEYCHAIN_ACL: "1",
				},
			},
		});
		const state = r.channel.current();
		expect(state.keyboard).toBe("software");
		expect(state.keychainAcl).toEqual({ enabled: true, generation: 0, itemsPath: `${DIR}/${KEYCHAIN_ACL_ITEMS_FILE}` });
		expect(r.make().on()).toBe(true);
	});

	test("unset follows the device's state: on stays on, never switched = a plain launch with nothing written", () => {
		const r = rig();
		expect(rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: undefined, dylib })).toEqual({
			success: true,
			data: { enabled: false, env: {} },
		});
		expect(r.files.has(STATE)).toBe(false);
		rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: true, dylib });
		const again = rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: undefined, dylib });
		expect(again.success && again.data.enabled).toBe(true);
	});

	test("off is recorded (a later driver launches plain) and launches plain", () => {
		const r = rig();
		rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: true, dylib });
		const off = rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: false, dylib });
		expect(off).toEqual({ success: true, data: { enabled: false, env: {} } });
		expect(r.channel.current().keychainAcl?.enabled).toBe(false);
		expect(r.make().on()).toBe(false);
	});

	test("the generation comes from the host file", () => {
		const r = rig();
		r.files.set(`${DIR}/${KEYCHAIN_ACL_GENERATION_FILE}`, JSON.stringify({ generation: 3 }));
		rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: true, dylib });
		expect(r.channel.current().keychainAcl?.generation).toBe(3);
	});

	test("no dylib: the error, nothing written", () => {
		const r = rig();
		const missing = () => driverErr("E_HELPER_MISSING", "no dylib");
		const got = rawLaunchKeychainAcl({ channel: r.channel, fs: r.fs, enabled: true, dylib: missing });
		expect(got.success).toBe(false);
		expect(r.files.has(STATE)).toBe(false);
	});
});
