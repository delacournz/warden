import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOriginHelpers } from "./install-origin";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("records, reads and clears the origin per binary path", () => {
	dir = mkdtempSync(join(tmpdir(), "warden-origin-"));
	const env = { WARDEN_HOME: dir };
	expect(installOriginHelpers.installOrigin(env, "/h/.local/bin/warden")).toBeUndefined();
	installOriginHelpers.recordInstallOrigin(env, "/h/.local/bin/warden", "npm");
	expect(installOriginHelpers.installOrigin(env, "/h/.local/bin/warden")).toBe("npm");
	expect(installOriginHelpers.installOrigin(env, "/elsewhere/warden")).toBeUndefined();
	installOriginHelpers.recordInstallOrigin(env, "/h/.local/bin/warden", undefined);
	expect(installOriginHelpers.installOrigin(env, "/h/.local/bin/warden")).toBeUndefined();
});

test("a corrupt file reads as no origin", async () => {
	dir = mkdtempSync(join(tmpdir(), "warden-origin-"));
	await Bun.write(join(dir, "install-origin.json"), "{nope");
	expect(installOriginHelpers.installOrigin({ WARDEN_HOME: dir }, "/x")).toBeUndefined();
});
