import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Credentials,
	clearCredentials,
	credentialsPath,
	DEFAULT_API_URL,
	readCredentials,
	resolveAuth,
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

	test("resolveAuth: WARDEN_TOKEN beats the saved file", () => {
		const env = home();
		writeCredentials(env, saved);
		const r = resolveAuth({ ...env, WARDEN_TOKEN: "ci_tok", WARDEN_API_URL: "https://ci.test" });
		expect(r).toEqual({ success: true, data: { kind: "env", apiUrl: "https://ci.test", token: "ci_tok" } });
	});

	test("resolveAuth: saved, else none on the default url", () => {
		const env = home();
		expect(resolveAuth(env)).toEqual({ success: true, data: { kind: "none", apiUrl: DEFAULT_API_URL } });
		writeCredentials(env, saved);
		expect(resolveAuth(env)).toEqual({
			success: true,
			data: { kind: "saved", apiUrl: saved.apiUrl, credentials: saved },
		});
	});

	test("resolveAuth: WARDEN_API_URL overrides a saved token only when it matches", () => {
		const env = home();
		writeCredentials(env, saved);
		const r = resolveAuth({ ...env, WARDEN_API_URL: "https://other.test" });
		expect(r).toEqual({ success: true, data: { kind: "none", apiUrl: "https://other.test" } });
	});
});
