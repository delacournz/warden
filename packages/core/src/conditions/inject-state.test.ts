import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectStatePath, switchOffKeychainAcl } from "./inject-state";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateFile(state?: Record<string, unknown>): string {
	const home = mkdtempSync(join(tmpdir(), "kacl-release-"));
	dirs.push(home);
	const path = injectStatePath(home, "U1");
	if (state) {
		mkdirSync(join(home, "inject", "U1"), { recursive: true });
		writeFileSync(path, JSON.stringify(state));
	}
	return path;
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("switchOffKeychainAcl (every release, condition or not)", () => {
	test("on → off with a higher seq; generation, sidecar path and the other keys kept", () => {
		const path = stateFile({
			seq: 4,
			keyboard: "software",
			offline: true,
			keychainAcl: { enabled: true, generation: 2, itemsPath: "/w/items.json" },
		});
		expect(switchOffKeychainAcl(path)).toBeUndefined();
		expect(read(path)).toEqual({
			seq: 5,
			keyboard: "software",
			offline: true,
			keychainAcl: { enabled: false, generation: 2, itemsPath: "/w/items.json" },
		});
	});

	test("already off, never switched, or no file: nothing written", () => {
		const off = stateFile({ seq: 4, keychainAcl: { enabled: false, generation: 0, itemsPath: "/w/i.json" } });
		switchOffKeychainAcl(off);
		expect(read(off).seq).toBe(4);
		const never = stateFile({ seq: 4, keyboard: "software" });
		switchOffKeychainAcl(never);
		expect(read(never)).toEqual({ seq: 4, keyboard: "software" });
		const none = stateFile();
		expect(switchOffKeychainAcl(none)).toBeUndefined();
		expect(existsSync(none)).toBe(false);
	});

	test("an unreadable file is left alone", () => {
		const path = stateFile();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "{nope");
		expect(switchOffKeychainAcl(path)).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe("{nope");
	});
});
