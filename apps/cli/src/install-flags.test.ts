import { describe, expect, test } from "bun:test";
import { installFlags } from "./install-flags";

describe("parseInstallFlags", () => {
	test("nothing set → nothing", () => {
		expect(installFlags.parseInstallFlags({})).toEqual({ success: true, data: {} });
	});

	test("--install-mode / --reset-keychain pass through", () => {
		expect(installFlags.parseInstallFlags({ installMode: "clean", resetKeychain: true })).toEqual({
			success: true,
			data: { installMode: "clean", resetKeychain: true },
		});
	});

	test("deprecated --clean = reinstall", () => {
		expect(installFlags.parseInstallFlags({ clean: true })).toEqual({
			success: true,
			data: { installMode: "reinstall" },
		});
	});

	test("--clean with --install-mode is an error", () => {
		expect(installFlags.parseInstallFlags({ clean: true, installMode: "clean" }).success).toBe(false);
	});

	test("--reset-keychain needs a mode", () => {
		const res = installFlags.parseInstallFlags({ resetKeychain: true });
		expect(res).toEqual({ success: false, error: "--reset-keychain needs --install-mode" });
	});
});
