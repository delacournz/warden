import { describe, expect, test } from "bun:test";
import { createInjectChannel, type InjectFs } from "./inject";
import { createIosKeyboard } from "./ios-keyboard";

const STATE = "/s/state.json";
const ACK = `${STATE}.ack`;

function rig(init: { dylib?: boolean; injected?: boolean; silent?: boolean } = {}) {
	const files = new Map<string, string>();
	const app = { injected: init.injected ?? false, silent: init.silent ?? false };
	const fs: InjectFs = {
		mkdir: () => undefined,
		writeAtomic: (path, text) => {
			files.set(path, text);
			if (path === STATE && app.injected && !app.silent) {
				files.set(ACK, JSON.stringify({ seq: (JSON.parse(text) as { seq: number }).seq, pid: 501 }));
			}
		},
		read: (path) => files.get(path),
		remove: (path) => void files.delete(path),
		pidAlive: (pid) => pid === 501,
	};
	let t = 0;
	const channel = createInjectChannel({
		statePath: STATE,
		fs,
		now: () => (t += 1),
		sleep: async (ms) => {
			t += ms;
		},
	});
	const keyboard = createIosKeyboard({
		channel,
		dylib: () =>
			init.dylib === false
				? { success: false, error: { code: "E_HELPER_MISSING", message: "no dylib", retryable: false } }
				: { success: true, data: "/d/libwarden-inject.dylib" },
	});
	return { keyboard, channel, files, app };
}

describe("iOS keyboard", () => {
	test("software is the mode until one is set", () => {
		expect(rig().keyboard.mode()).toBe("software");
	});

	test("a launch with nothing else to inject loads the dylib in the default mode", () => {
		const { keyboard } = rig();
		const env = keyboard.launchEnv();
		expect(env).toMatchObject({
			DYLD_INSERT_LIBRARIES: "/d/libwarden-inject.dylib",
			WARDEN_INJECT_STATE: STATE,
			WARDEN_KEYBOARD: "software",
		});
	});

	test("a missing dylib is a plain launch, not a failure", () => {
		expect(rig({ dylib: false }).keyboard.launchEnv()).toBeUndefined();
	});

	test("launchMode names the mode for a launch another layer injects", () => {
		expect(rig().keyboard.launchMode()).toEqual({ WARDEN_KEYBOARD: "software" });
	});

	test("setting a mode with no app attached stages it for the next launch", async () => {
		const { keyboard, channel } = rig();
		const set = await keyboard.keyboard("hardware");
		expect(set).toEqual({ success: true, data: { mode: "hardware", appliesOnLaunch: true } });
		expect(channel.current().keyboard).toBe("hardware");
		expect(keyboard.launchEnv()).toMatchObject({ WARDEN_KEYBOARD: "hardware" });
	});

	test("an attached app acknowledges the change live", async () => {
		const { keyboard, app, files } = rig({ injected: true });
		files.set(ACK, '{"seq":0,"pid":501}');
		app.injected = true;
		const set = await keyboard.keyboard("hardware");
		expect(set).toEqual({ success: true, data: { mode: "hardware" } });
	});

	test("an attached app that never answers is E_TIMEOUT", async () => {
		const { keyboard, files, app } = rig({ injected: true, silent: true });
		files.set(ACK, '{"seq":0,"pid":501}');
		app.silent = true;
		const set = await keyboard.keyboard("hardware");
		expect(set.success).toBe(false);
		if (!set.success) expect(set.error.code).toBe("E_TIMEOUT");
	});

	test("confirmLoaded fails when the launched app never acked the dylib", async () => {
		const { keyboard } = rig();
		keyboard.launchEnv();
		const loaded = await keyboard.confirmLoaded();
		expect(loaded.success).toBe(false);
	});

	test("dismiss writes a one-shot request the app acknowledges and keeps the mode", async () => {
		const { keyboard, files, channel } = rig({ injected: true });
		await keyboard.keyboard("hardware");
		const done = await keyboard.dismiss();
		expect(done).toEqual({ success: true, data: { attached: true } });
		const written = JSON.parse(files.get(STATE) ?? "{}") as { dismissKeyboard?: boolean; keyboard?: string };
		expect(written).toMatchObject({ dismissKeyboard: true, keyboard: "hardware" });
		expect(channel.current()).not.toHaveProperty("dismissKeyboard");
		await keyboard.keyboard("software");
		expect(JSON.parse(files.get(STATE) ?? "{}")).not.toHaveProperty("dismissKeyboard");
	});

	test("dismiss without the dylib loaded writes nothing and says so", async () => {
		const { keyboard, files } = rig({ injected: false });
		expect(await keyboard.dismiss()).toEqual({ success: true, data: { attached: false } });
		expect(files.has(STATE)).toBe(false);
	});

	test("dismiss that is never acknowledged times out", async () => {
		const { keyboard, app } = rig({ injected: true });
		await keyboard.keyboard("software");
		app.silent = true;
		const done = await keyboard.dismiss();
		expect(!done.success && done.error.code).toBe("E_TIMEOUT");
	});
});
