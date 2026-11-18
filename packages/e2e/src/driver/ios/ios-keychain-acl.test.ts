import { describe, expect, test } from "bun:test";
import { createInjectChannel, type InjectFs } from "./inject";
import { createIosKeychainAcl, KEYCHAIN_ACL_GENERATION_FILE, KEYCHAIN_ACL_ITEMS_FILE } from "./ios-keychain-acl";

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
	return { files, channel, kacl, make, writeState };
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
