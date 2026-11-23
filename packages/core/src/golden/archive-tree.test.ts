import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../exec";
import { checkArchiveLinks, dropSpecialFiles, summarizeTree } from "./archive-tree";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "warden-archive-tree-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(dir: string): void {
	mkdirSync(join(dir, "data/Library/Preferences"), { recursive: true });
	mkdirSync(join(dir, "data/empty"), { recursive: true });
	writeFileSync(join(dir, "data/Library/Preferences/a.plist"), "aaaa");
	writeFileSync(join(dir, "data/b"), "bb");
	symlinkSync("Preferences/a.plist", join(dir, "data/Library/link"));
}

describe("summarizeTree", () => {
	test("the same tree elsewhere has the same summary, whatever order it was written in", () => {
		seed(join(root, "one"));
		mkdirSync(join(root, "two/data"), { recursive: true });
		writeFileSync(join(root, "two/data/b"), "bb");
		seed(join(root, "two"));
		const one = summarizeTree(join(root, "one"));
		expect(one).toEqual(summarizeTree(join(root, "two")));
		expect(one.success && one.data.entries).toBe(7);
		expect(one.success && one.data.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a missing, added, renamed, resized or retyped entry and a re-pointed link each change it", () => {
		seed(join(root, "base"));
		const base = summarizeTree(join(root, "base"));
		const changes: Array<(dir: string) => void> = [
			(dir) => rmSync(join(dir, "data/b")),
			(dir) => rmSync(join(dir, "data/empty"), { recursive: true }),
			(dir) => writeFileSync(join(dir, "data/extra"), ""),
			(dir) => renameSync(join(dir, "data/b"), join(dir, "data/c")),
			(dir) => writeFileSync(join(dir, "data/b"), "bbb"),
			(dir) => {
				rmSync(join(dir, "data/b"));
				mkdirSync(join(dir, "data/b"));
			},
			(dir) => {
				rmSync(join(dir, "data/Library/link"));
				symlinkSync("Preferences", join(dir, "data/Library/link"));
			},
		];
		for (const [index, change] of changes.entries()) {
			const dir = join(root, `changed-${index}`);
			seed(dir);
			change(dir);
			expect(summarizeTree(dir)).not.toEqual(base);
		}
	});

	test("a name cannot stand in for two entries", () => {
		mkdirSync(join(root, "a"));
		writeFileSync(join(root, "a", "x 1\nf y"), "");
		mkdirSync(join(root, "b"));
		writeFileSync(join(root, "b", "x"), "1");
		writeFileSync(join(root, "b", "y"), "");
		expect(summarizeTree(join(root, "a"))).not.toEqual(summarizeTree(join(root, "b")));
	});

	test("a FIFO or socket is an error naming it", async () => {
		mkdirSync(join(root, "t/data"), { recursive: true });
		await bunExec(["mkfifo", join(root, "t/data/pipe")]);
		expect(summarizeTree(join(root, "t"))).toEqual({
			success: false,
			error: "data/pipe is neither a file, a directory nor a symlink",
		});
	});
});

describe("dropSpecialFiles", () => {
	test("removes what is neither a file, a directory nor a symlink, and nothing else", async () => {
		seed(join(root, "t"));
		await bunExec(["mkfifo", join(root, "t/data/pipe")]);
		const before = summarizeTree(join(root, "t"));
		expect(before.success).toBe(false);
		expect(dropSpecialFiles(join(root, "t"))).toEqual(["data/pipe"]);
		expect(existsSync(join(root, "t/data/pipe"))).toBe(false);
		const after = summarizeTree(join(root, "t"));
		expect(after.success && after.data.entries).toBe(7);
	});
});

describe("checkArchiveLinks", () => {
	const HOME = "/Users/ci";
	const from = { udid: "OLD-UDID", home: HOME };
	const device = `${HOME}/Library/Developer/CoreSimulator/Devices/OLD-UDID`;

	function withLink(target: string, at = "data/Library/link"): string {
		const dir = mkdtempSync(join(root, "links-"));
		mkdirSync(join(dir, "data/Library/Preferences"), { recursive: true });
		symlinkSync(target, join(dir, at));
		return dir;
	}

	test("links inside the tree, into the exporting device's dir and to its log dir pass", () => {
		for (const target of [
			"Preferences",
			"../Library/Preferences",
			"../../data",
			"dangling-name",
			`${device}/data/Library/Preferences`,
			device,
			`${HOME}/Library/Logs/CoreSimulator/OLD-UDID`,
		]) {
			expect(checkArchiveLinks(withLink(target), from)).toEqual({ success: true, data: undefined });
		}
	});

	test("a relative link that leaves the tree, or climbs after descending, is refused", () => {
		for (const target of ["../../..", "../../../etc/passwd", "Preferences/../../../../x", "a/../b"]) {
			const result = checkArchiveLinks(withLink(target), from);
			expect(result).toEqual({
				success: false,
				error: `data/Library/link points outside the device (${target})`,
			});
		}
	});

	test("an absolute link anywhere but this device's own dirs is refused", () => {
		for (const target of [
			"/etc/passwd",
			`${HOME}/.ssh`,
			`${HOME}/Library/Developer/CoreSimulator/Devices/OTHER-UDID/data`,
			`${device}-2/data`,
			`${device}/../OTHER-UDID`,
			`/tmp/CoreSimulator/OLD-UDID`,
			`/Users/other/Library/Developer/CoreSimulator/Devices/OLD-UDID/data`,
		]) {
			const result = checkArchiveLinks(withLink(target), from);
			expect(result).toEqual({
				success: false,
				error: `data/Library/link points outside the device (${target})`,
			});
		}
	});

	test("an archive that does not record its home: any user's CoreSimulator dirs for this udid, nothing else", () => {
		const noHome = { udid: "OLD-UDID" };
		expect(checkArchiveLinks(withLink(`${device}/data`), noHome).success).toBe(true);
		expect(checkArchiveLinks(withLink("/private/tmp/h/Library/Logs/CoreSimulator/OLD-UDID"), noHome).success).toBe(
			true
		);
		expect(checkArchiveLinks(withLink("/tmp/CoreSimulator/OLD-UDID"), noHome).success).toBe(false);
		expect(checkArchiveLinks(withLink("/etc/OLD-UDID"), noHome).success).toBe(false);
	});
});
