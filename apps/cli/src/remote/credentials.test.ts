import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ACCOUNT_NAME,
	type Credentials,
	clearAllAccounts,
	clearCredentials,
	credentialsPath,
	DEFAULT_ACCOUNT,
	isAccountName,
	readAccounts,
	readCredentials,
	removeAccount,
	setDefaultAccount,
	writeAccount,
	writeCredentials,
} from "./credentials";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function home(): Record<string, string | undefined> {
	dir = mkdtempSync(join(tmpdir(), "warden-creds-"));
	return { WARDEN_HOME: dir };
}

const saved: Credentials = {
	apiUrl: "https://api.example.test",
	token: "tok_123",
	user: { id: "u1", email: "a@b.test" },
	organizationId: "org1",
	savedAt: 1000,
};

describe("credentials", () => {
	test("missing file reads as undefined", () => {
		const env = home();
		expect(readCredentials(env)).toEqual({ success: true, data: undefined });
	});

	test("write then read round-trips, file is 0600", () => {
		const env = home();
		expect(writeCredentials(env, saved).success).toBe(true);
		expect(readCredentials(env)).toEqual({ success: true, data: saved });
		expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
	});

	test("malformed file is an error, not a crash", () => {
		const env = home();
		writeFileSync(credentialsPath(env), "{not json");
		expect(readCredentials(env).success).toBe(false);
		writeFileSync(credentialsPath(env), JSON.stringify({ token: 1 }));
		expect(readCredentials(env).success).toBe(false);
	});

	test("clear removes the file and reports whether one existed", () => {
		const env = home();
		writeCredentials(env, saved);
		expect(clearCredentials(env)).toBe(true);
		expect(clearCredentials(env)).toBe(false);
		expect(readCredentials(env)).toEqual({ success: true, data: undefined });
	});
});

const other: Credentials = { ...saved, token: "tok_other", user: { id: "u2", email: "c@d.test" }, savedAt: 2000 };

describe("accounts", () => {
	test("isAccountName / ACCOUNT_NAME", () => {
		expect(DEFAULT_ACCOUNT).toBe("default");
		expect(isAccountName("work-1")).toBe(true);
		expect(ACCOUNT_NAME.test("a")).toBe(true);
		for (const bad of ["", "-a", "A", "a_b", "a b", "a".repeat(33)]) expect(isAccountName(bad)).toBe(false);
	});

	test("readAccounts: no file is undefined", () => {
		expect(readAccounts(home())).toEqual({ success: true, data: undefined });
	});

	test("v1 file migrates in memory, rewritten as v2 on next write", () => {
		const env = home();
		writeFileSync(credentialsPath(env), JSON.stringify(saved));
		expect(readAccounts(env)).toEqual({
			success: true,
			data: { version: 2, default: "default", accounts: { default: saved } },
		});
		expect(JSON.parse(readFileSync(credentialsPath(env), "utf8")).version).toBeUndefined();
		writeAccount(env, "work", other);
		const file = JSON.parse(readFileSync(credentialsPath(env), "utf8"));
		expect(file.version).toBe(2);
		expect(Object.keys(file.accounts).sort()).toEqual(["default", "work"]);
	});

	test("first account becomes default; a second does not change it", () => {
		const env = home();
		const first = writeAccount(env, "work", saved);
		expect(first).toEqual({ success: true, data: { version: 2, default: "work", accounts: { work: saved } } });
		const second = writeAccount(env, "home", other);
		expect(second).toEqual({
			success: true,
			data: { version: 2, default: "work", accounts: { work: saved, home: other } },
		});
		expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
	});

	test("writeAccount overwrites an existing account", () => {
		const env = home();
		writeAccount(env, "work", saved);
		const r = writeAccount(env, "work", other);
		expect(r).toEqual({ success: true, data: { version: 2, default: "work", accounts: { work: other } } });
	});

	test("invalid name errs and writes nothing", () => {
		const env = home();
		expect(writeAccount(env, "Bad Name", saved).success).toBe(false);
		expect(readAccounts(env)).toEqual({ success: true, data: undefined });
	});

	test("removing the default promotes the alphabetically first remaining", () => {
		const env = home();
		writeAccount(env, "mid", saved);
		writeAccount(env, "zed", other);
		writeAccount(env, "alpha", other);
		const r = removeAccount(env, "mid");
		expect(r.success && r.data.removed).toBe(true);
		expect(r.success && r.data.accounts?.default).toBe("alpha");
	});

	test("removing a non-default keeps the default; unknown name is removed:false", () => {
		const env = home();
		writeAccount(env, "a", saved);
		writeAccount(env, "b", other);
		const r = removeAccount(env, "b");
		expect(r.success && r.data.accounts?.default).toBe("a");
		const none = removeAccount(env, "nope");
		expect(none.success && none.data.removed).toBe(false);
	});

	test("removing the last account deletes the file", () => {
		const env = home();
		writeAccount(env, "a", saved);
		const r = removeAccount(env, "a");
		expect(r).toEqual({ success: true, data: { removed: true, accounts: undefined } });
		expect(existsSync(credentialsPath(env))).toBe(false);
	});

	test("setDefaultAccount switches, errs when missing", () => {
		const env = home();
		writeAccount(env, "a", saved);
		writeAccount(env, "b", other);
		const r = setDefaultAccount(env, "b");
		expect(r.success && r.data.default).toBe("b");
		expect(readCredentials(env)).toEqual({ success: true, data: other });
		expect(setDefaultAccount(env, "zzz")).toEqual({ success: false, error: "no account zzz (warden account list)" });
	});

	test("clearAllAccounts deletes the file", () => {
		const env = home();
		writeAccount(env, "a", saved);
		expect(clearAllAccounts(env)).toBe(true);
		expect(clearAllAccounts(env)).toBe(false);
	});

	test("damaged v2 file errs", () => {
		const env = home();
		writeFileSync(credentialsPath(env), JSON.stringify({ version: 2, default: "x", accounts: {} }));
		expect(readAccounts(env).success).toBe(false);
	});
});
