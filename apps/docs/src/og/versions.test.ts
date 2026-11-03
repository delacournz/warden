import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ogVersions } from "./versions";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "og-versions-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("ogVersions", () => {
	test("keys every card by its public path, nested ones too", () => {
		mkdirSync(join(dir, "og/docs/e2e"), { recursive: true });
		writeFileSync(join(dir, "og/default.png"), "a");
		writeFileSync(join(dir, "og/docs/e2e/specs.png"), "b");
		writeFileSync(join(dir, "og/notes.txt"), "c");

		const versions = ogVersions(join(dir, "og"));
		expect(Object.keys(versions).sort()).toEqual(["/og/default.png", "/og/docs/e2e/specs.png"]);
		expect(versions["/og/default.png"]).toMatch(/^[0-9a-f]{10}$/);
	});

	test("the version follows the card's bytes", () => {
		mkdirSync(join(dir, "og"));
		writeFileSync(join(dir, "og/default.png"), "old");
		const before = ogVersions(join(dir, "og"))["/og/default.png"];
		writeFileSync(join(dir, "og/default.png"), "new");
		expect(ogVersions(join(dir, "og"))["/og/default.png"]).not.toBe(before);
	});

	test("no cards yet (dev before seo:assets) is an empty map", () => {
		expect(ogVersions(join(dir, "missing"))).toEqual({});
	});
});
