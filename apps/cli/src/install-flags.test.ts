import { describe, expect, test } from "bun:test";
import { parseInstallFlags } from "./install-flags";

describe("parseInstallFlags", () => {
	test("nothing set → nothing", () => {
		expect(parseInstallFlags({})).toEqual({ success: true, data: {} });
	});

	test("--install-mode / --reset-keychain pass through", () => {
		expect(parseInstallFlags({ installMode: "clean", resetKeychain: true })).toEqual({
			success: true,
			data: { installMode: "clean", resetKeychain: true },
		});
	});

	test("deprecated --clean = reinstall", () => {
		expect(parseInstallFlags({ clean: true })).toEqual({ success: true, data: { installMode: "reinstall" } });
	});

	test("--clean with --install-mode is an error", () => {
		expect(parseInstallFlags({ clean: true, installMode: "clean" }).success).toBe(false);
	});

	test("--reset-keychain needs a mode", () => {
		const res = parseInstallFlags({ resetKeychain: true });
		expect(res).toEqual({ success: false, error: "--reset-keychain needs --install-mode" });
	});
});
