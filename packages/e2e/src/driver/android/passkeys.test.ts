import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PasskeyCredential } from "@delacour/warden-core/conditions/conditions.types";
import {
	createPasskeyCredential,
	passkeyStorePath,
	readPasskeyStore,
} from "@delacour/warden-core/conditions/passkey-store";
import type { DriverResult, Element } from "../driver.types";
import { type AndroidPasskeysDeps, createAndroidPasskeys } from "./passkeys";

const SERIAL = "emulator-5554";
const PKG = "nz.co.delacour.warden.passkeys";
const COMPONENT = `${PKG}/${PKG}.WardenPasskeyService`;
const GMS =
	"com.google.android.gms/com.google.android.gms.auth.api.credentials.credman.service.PasswordAndPasskeyService";
const APK = { packageName: PKG, versionName: "v1", bytes: 3, apkSha256: "ab".repeat(32) };

type World = {
	sdk: number | undefined;
	installed: string | undefined;
	settings: Record<string, string | undefined>;
	store: { mode: string; uv: string; credentials: PasskeyCredential[] };
	shell: string[][];
	installs: string[];
};

let home: string;
let world: World;

function freshStore(): World["store"] {
	return { mode: "auto", uv: "match", credentials: [] };
}

function answer(argv: readonly string[]): { ok: boolean; stdout: string } {
	const [a, b, c, d] = argv;
	if (a === "dumpsys")
		return {
			ok: true,
			stdout: world.installed
				? `Packages:\n  versionName=${world.installed}\n  versionCode=1\n`
				: "Unable to find package\n",
		};
	if (a === "settings" && b === "get") return { ok: true, stdout: `${world.settings[d ?? ""] ?? "null"}\n` };
	if (a === "settings" && b === "put") {
		world.settings[c === "secure" ? (d ?? "") : ""] = argv[4];
		return { ok: true, stdout: "" };
	}
	if (a === "pm" && b === "uninstall") {
		world.installed = undefined;
		world.store = freshStore();
		return { ok: true, stdout: "Success\n" };
	}
	if (a === "content") return provider(argv);
	return { ok: true, stdout: "" };
}

function provider(argv: readonly string[]): { ok: boolean; stdout: string } {
	if (world.installed === undefined) return { ok: false, stdout: "Error: Unknown authority" };
	const method = argv[argv.indexOf("--method") + 1];
	const arg = argv.includes("--arg") ? argv[argv.indexOf("--arg") + 1] : undefined;
	const extras = argv.flatMap((x, i) => (argv[i - 1] === "--extra" ? [x] : []));
	const extra = (key: string): string | undefined =>
		extras.find((e) => e.startsWith(`${key}:s:`))?.slice(key.length + 3);
	if (method === "setMode") {
		world.store.mode = extra("mode") ?? world.store.mode;
		world.store.uv = extra("uv") ?? world.store.uv;
	} else if (method === "add") {
		const record = JSON.parse(Buffer.from(extra("b64") ?? "", "base64").toString("utf8")) as PasskeyCredential;
		world.store.credentials = [
			...world.store.credentials.filter((c) => c.credentialId !== record.credentialId),
			record,
		];
	} else if (method === "remove") {
		world.store.credentials = world.store.credentials.filter((c) => c.credentialId !== arg);
	} else if (method === "clear") {
		world.store.credentials = [];
	} else if (method === "boom") {
		return { ok: true, stdout: "Result: Bundle[{error=java.lang.IllegalStateException: boom}]\n" };
	}
	return { ok: true, stdout: `Result: Bundle[{result=${JSON.stringify(world.store)}}]\n` };
}

function make(over: Partial<AndroidPasskeysDeps> = {}) {
	return createAndroidPasskeys({
		serial: SERIAL,
		wardenHome: home,
		sdk: async () => world.sdk,
		shell: async (argv) => {
			world.shell.push([...argv]);
			return answer(argv);
		},
		install: async (path): DriverResult<void> => {
			world.installs.push(path);
			world.installed = APK.versionName;
			return { success: true, data: undefined };
		},
		apk: APK,
		load: async () => ({ success: true, data: { bytes: new Uint8Array([1, 2, 3]), source: "cache" } }),
		...over,
	});
}

function cred(userName: string, createdAt: number, rpId = "example.com"): PasskeyCredential {
	const made = createPasskeyCredential({ rpId, userName }, { now: () => createdAt });
	if (!made.success) throw new Error(made.error);
	return made.data;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-pk-"));
	world = {
		sdk: 37,
		installed: undefined,
		settings: { credential_service: GMS, credential_service_primary: GMS },
		store: freshStore(),
		shell: [],
		installs: [],
	};
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function ok<T>(r: { success: true; data: T } | { success: false; error: { code: string; message: string } }): T {
	if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
	return r.data;
}

describe("api level", () => {
	test("below API 34 is E_PASSKEY_API for every op and touches nothing", async () => {
		world.sdk = 33;
		const { op } = make();
		for (const request of [{ kind: "set" }, { kind: "status" }, { kind: "list" }, { kind: "off" }] as const) {
			const r = await op(request);
			expect(r.success).toBe(false);
			if (!r.success) expect(r.error.code).toBe("E_PASSKEY_API");
		}
		expect(world.shell).toEqual([]);
		expect(world.installs).toEqual([]);
	});

	test("an unknown API level is refused too", async () => {
		world.sdk = undefined;
		const r = await make().op({ kind: "status" });
		expect(r.success).toBe(false);
	});
});

describe("set", () => {
	test("installs the app, enables it, reports the provider it replaced and sets auto/match", async () => {
		const state = ok(await make().op({ kind: "set" }));
		expect(world.installs).toHaveLength(1);
		expect(world.settings.credential_service).toBe(COMPONENT);
		expect(world.settings.credential_service_primary).toBe(COMPONENT);
		expect(state).toMatchObject({
			enabled: true,
			mode: "auto",
			uv: "match",
			previousProvider: { service: GMS, primary: GMS },
		});
	});

	test("an unset prior provider is null, an empty one (an uninstall's leftover) too", async () => {
		world.settings = { credential_service: "", credential_service_primary: undefined };
		const state = ok(await make().op({ kind: "set" }));
		expect(state.previousProvider).toEqual({ service: null, primary: null });
	});

	test("the second op neither reinstalls nor reports a previous provider", async () => {
		const { op } = make();
		await op({ kind: "set" });
		const again = ok(await op({ kind: "set", mode: "cancel", uv: "skip" }));
		expect(world.installs).toHaveLength(1);
		expect(again.previousProvider).toBeUndefined();
		expect(again).toMatchObject({ enabled: true, mode: "cancel", uv: "skip" });
	});

	test("a field left out keeps its value", async () => {
		const { op } = make();
		await op({ kind: "set", mode: "fail", uv: "nomatch" });
		expect(ok(await op({ kind: "set", mode: "auto" }))).toMatchObject({ mode: "auto", uv: "nomatch" });
	});

	test("a stale install is replaced and the host store's credentials go back in", async () => {
		const { op } = make();
		await op({ kind: "add", credential: cred("alice", 1) });
		world.installed = "old";
		world.store = freshStore();
		const state = ok(await op({ kind: "status" }));
		expect(state.credentials).toEqual([]);
		const set = ok(await op({ kind: "set" }));
		expect(world.shell.some((a) => a.join(" ") === `pm uninstall ${PKG}`)).toBe(true);
		expect(world.installed).toBe("v1");
		expect(set.credentials.map((c) => c.userName)).toEqual(["alice"]);
	});

	test("a failed install is that error", async () => {
		const r = await make({
			install: async () => ({
				success: false,
				error: { code: "E_IO", message: "adb install failed", retryable: false },
			}),
		}).op({ kind: "set" });
		expect(r.success).toBe(false);
		expect(world.settings.credential_service).toBe(GMS);
	});
});

describe("getting the APK", () => {
	test("a loader that fails is E_IO naming the APK and nothing is installed", async () => {
		const r = await make({ load: async () => ({ success: false, error: "no network" }) }).op({ kind: "set" });
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.code).toBe("E_IO");
			expect(r.error.message).toContain("warden-passkeys");
			expect(r.error.message).toContain("no network");
		}
		expect(world.installs).toEqual([]);
	});
});

describe("credentials", () => {
	test("add enables the provider, stores the credential and mirrors it to the host store", async () => {
		const credential = cred("alice", 5);
		const state = ok(await make().op({ kind: "add", credential }));
		expect(state.previousProvider).toEqual({ service: GMS, primary: GMS });
		expect(state.credentials.map((c) => c.credentialId)).toEqual([credential.credentialId]);
		expect(state.credentials[0]?.privateKey).toBeUndefined();
		const host = readPasskeyStore(passkeyStorePath(home, SERIAL));
		expect(host.success && host.data[0]?.privateKey).toBe(credential.privateKey);
	});

	test("list is newest first, filtered by rp, keys only with withKeys", async () => {
		const { op } = make();
		await op({ kind: "add", credential: cred("old", 1) });
		await op({ kind: "add", credential: cred("new", 9) });
		await op({ kind: "add", credential: cred("other", 5, "other.org") });
		const listed = ok(await op({ kind: "list", rpId: "example.com" }));
		expect(listed.credentials.map((c) => c.userName)).toEqual(["new", "old"]);
		const withKeys = ok(await op({ kind: "list", withKeys: true }));
		expect(withKeys.credentials.every((c) => typeof c.privateKey === "string")).toBe(true);
	});

	test("remove and clear mirror too", async () => {
		const { op } = make();
		const a = cred("a", 1);
		await op({ kind: "add", credential: a });
		await op({ kind: "add", credential: cred("b", 2) });
		ok(await op({ kind: "remove", credentialId: a.credentialId }));
		let host = readPasskeyStore(passkeyStorePath(home, SERIAL));
		expect(host.success && host.data.map((c) => c.userName)).toEqual(["b"]);
		ok(await op({ kind: "clear" }));
		host = readPasskeyStore(passkeyStorePath(home, SERIAL));
		expect(host.success && host.data).toEqual([]);
	});

	test("a host store that cannot be written is E_PASSKEY_STORE", async () => {
		await make().op({ kind: "set" });
		const r = await make({ wardenHome: "/dev/null/nope" }).op({ kind: "add", credential: cred("a", 1) });
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("E_PASSKEY_STORE");
	});
});

describe("status, list and off with nothing installed", () => {
	test("status is off and changes nothing on the device", async () => {
		const state = ok(await make().op({ kind: "status" }));
		expect(state).toMatchObject({ enabled: false, credentials: [] });
		expect(world.installs).toEqual([]);
		expect(world.settings.credential_service).toBe(GMS);
	});

	test("off with nothing installed is a no-op", async () => {
		expect(ok(await make().op({ kind: "off" })).enabled).toBe(false);
		expect(world.installs).toEqual([]);
	});

	test("off keeps the app and the credentials, mode off", async () => {
		const { op } = make();
		await op({ kind: "add", credential: cred("a", 1) });
		const off = ok(await op({ kind: "off" }));
		expect(off).toMatchObject({ enabled: false });
		expect(off.credentials).toHaveLength(1);
		expect(world.store.mode).toBe("off");
		expect(ok(await op({ kind: "set" }))).toMatchObject({ enabled: true, mode: "auto" });
	});

	test("the host store is never created by a read", async () => {
		await make().op({ kind: "status" });
		expect(existsSync(passkeyStorePath(home, SERIAL))).toBe(false);
	});
});

describe("provider errors", () => {
	test("an error bundle is E_IO with its text", async () => {
		const state = make();
		await state.op({ kind: "set" });
		world.shell.length = 0;
		world.installed = "v1";
		const shell = (argv: readonly string[]) => {
			world.shell.push([...argv]);
			return Promise.resolve(
				argv[0] === "content"
					? { ok: true, stdout: "Result: Bundle[{error=java.lang.IllegalStateException: boom}]\n" }
					: answer(argv)
			);
		};
		const r = await make({ shell }).op({ kind: "clear" });
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.code).toBe("E_IO");
			expect(r.error.message).toContain("boom");
		}
	});
});

describe("sheetFor", () => {
	let n = 0;
	const t = (text: string): Element => {
		n++;
		return {
			id: `0.${n}`,
			role: "text",
			rawType: "android.view.View",
			text,
			frame: { x: 0, y: 0, width: 1, height: 1 },
			normFrame: { x: 0, y: 0, width: 0, height: 0 },
			traits: [],
			enabled: true,
			depth: 1,
			children: [],
		};
	};
	const create = [t("Save another way"), t("Continue")];

	test("a screen that is not the sheet costs no device call", async () => {
		const { sheetFor } = make();
		expect(await sheetFor([t("Welcome")])).toBeUndefined();
		expect(world.shell).toEqual([]);
	});

	test("taps Continue in auto once the provider is enabled", async () => {
		const { op, sheetFor } = make();
		await op({ kind: "set" });
		const action = await sheetFor(create);
		expect(action?.do === "tap" && action.element.text).toBe("Continue");
	});

	test("leaves the sheet when warden's provider is not the device's", async () => {
		const { op, sheetFor } = make();
		await op({ kind: "set" });
		world.settings.credential_service = GMS;
		expect(await sheetFor(create)).toBeUndefined();
	});

	test("leaves the sheet in mode off", async () => {
		const { op, sheetFor } = make();
		await op({ kind: "set" });
		await op({ kind: "off" });
		expect(await sheetFor(create)).toBeUndefined();
	});
});
