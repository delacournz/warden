import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import {
	decideReuse,
	derivedDataDir,
	embeddedProfiles,
	findXctestrun,
	PROFILE_MARGIN_MS,
	parseProfileExpiry,
	type RunnerMeta,
	readProfileExpiry,
	readRunnerMeta,
	runnerCacheDir,
	UNKNOWN_PROFILE_LIFETIME_MS,
	writeRunnerMeta,
} from "./cache";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-runner-cache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const meta = (over: Partial<RunnerMeta> = {}): RunnerMeta => ({
	udids: ["U1"],
	profileExpires: NOW + 5 * DAY,
	builtAt: NOW - DAY,
	bundleId: "b.id",
	...over,
});
const base = { xctestrun: "/x.xctestrun", udid: "U1", bundleId: "b.id", now: NOW };

describe("decideReuse", () => {
	test("hit", () => expect(decideReuse({ ...base, meta: meta() })).toEqual({ reuse: true }));
	test("no meta", () => expect(decideReuse({ ...base, meta: undefined })).toEqual({ reuse: false, because: "none" }));
	test("new udid", () =>
		expect(decideReuse({ ...base, meta: meta(), udid: "U2" })).toEqual({ reuse: false, because: "new_udid" }));
	test("another bundle id", () =>
		expect(decideReuse({ ...base, meta: meta({ bundleId: "other" }) })).toEqual({
			reuse: false,
			because: "bundle_id",
		}));
	test("products gone", () =>
		expect(decideReuse({ ...base, meta: meta(), xctestrun: undefined })).toEqual({ reuse: false, because: "missing" }));
	test("profile ends within 24 h", () => {
		const soon = meta({ profileExpires: NOW + PROFILE_MARGIN_MS - 1 });
		expect(decideReuse({ ...base, meta: soon })).toEqual({ reuse: false, because: "profile_expiring" });
		const fine = meta({ profileExpires: NOW + PROFILE_MARGIN_MS + 1 });
		expect(decideReuse({ ...base, meta: fine })).toEqual({ reuse: true });
	});
	test("unreadable expiry counts from the build time", () => {
		const unknown = (age: number) => meta({ profileExpires: null, builtAt: NOW - age });
		expect(decideReuse({ ...base, meta: unknown(UNKNOWN_PROFILE_LIFETIME_MS - 2 * DAY) })).toEqual({ reuse: true });
		expect(decideReuse({ ...base, meta: unknown(UNKNOWN_PROFILE_LIFETIME_MS - DAY / 2) })).toEqual({
			reuse: false,
			because: "profile_expiring",
		});
	});
});

describe("meta.json", () => {
	test("round trips and lives under <team>/<xcode>-<hash>", () => {
		const cache = runnerCacheDir(dir, "LN69P7N673", "27A9275", "abc");
		expect(cache).toBe(join(dir, "ios-runner", "LN69P7N673", "27A9275-abc"));
		expect(derivedDataDir(cache)).toBe(join(cache, "dd"));
		writeRunnerMeta(cache, meta());
		expect(readRunnerMeta(cache)).toEqual(meta());
	});

	test("missing, torn or foreign files read as no meta", () => {
		expect(readRunnerMeta(join(dir, "nope"))).toBeUndefined();
		writeFileSync(join(dir, "meta.json"), '{"udids":[');
		expect(readRunnerMeta(dir)).toBeUndefined();
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ udids: "U1" }));
		expect(readRunnerMeta(dir)).toBeUndefined();
	});
});

describe("products", () => {
	function products(dd: string) {
		const p = join(dd, "Build", "Products");
		mkdirSync(join(p, "Debug-iphoneos", "WardenRunnerHost.app"), { recursive: true });
		mkdirSync(join(p, "Debug-iphoneos", "WardenRunnerUITests-Runner.app"), { recursive: true });
		mkdirSync(join(p, "Debug-iphoneos", "Other.framework"), { recursive: true });
		writeFileSync(join(p, "Debug-iphoneos", "WardenRunnerHost.app", "embedded.mobileprovision"), "x");
		writeFileSync(join(p, "Debug-iphoneos", "WardenRunnerUITests-Runner.app", "embedded.mobileprovision"), "y");
		writeFileSync(join(p, "WardenRunner_iphoneos27.2-arm64.xctestrun"), "<plist/>");
		return p;
	}

	test("findXctestrun", () => {
		expect(findXctestrun(join(dir, "dd"))).toBeUndefined();
		const p = products(join(dir, "dd"));
		expect(findXctestrun(join(dir, "dd"))).toBe(join(p, "WardenRunner_iphoneos27.2-arm64.xctestrun"));
	});

	test("embeddedProfiles lists both apps", () => {
		products(join(dir, "dd"));
		expect(embeddedProfiles(join(dir, "dd")).map((p) => p.split("/").slice(-2, -1)[0])).toEqual([
			"WardenRunnerHost.app",
			"WardenRunnerUITests-Runner.app",
		]);
	});

	test("parseProfileExpiry reads ExpirationDate", () => {
		const plist = `<dict><key>CreationDate</key><date>2026-10-29T00:00:00Z</date>\n<key>ExpirationDate</key>\n<date>2026-11-05T01:02:03Z</date></dict>`;
		expect(parseProfileExpiry(plist)).toBe(Date.parse("2026-11-05T01:02:03Z"));
		expect(parseProfileExpiry("<dict/>")).toBeUndefined();
	});

	test("readProfileExpiry takes the earliest, skipping unreadable profiles", async () => {
		products(join(dir, "dd"));
		const dates = new Map([
			["WardenRunnerHost.app", "2026-11-05T00:00:00Z"],
			["WardenRunnerUITests-Runner.app", "2026-11-03T00:00:00Z"],
		]);
		const exec: Exec = async (cmd) => {
			const app = [...dates.keys()].find((k) => cmd.join(" ").includes(k));
			return app === undefined
				? { exitCode: 1, stdout: "", stderr: "" }
				: { exitCode: 0, stdout: `<key>ExpirationDate</key><date>${dates.get(app)}</date>`, stderr: "" };
		};
		expect(await readProfileExpiry(exec, join(dir, "dd"))).toBe(Date.parse("2026-11-03T00:00:00Z"));
		const broken: Exec = async () => ({ exitCode: 1, stdout: "", stderr: "" });
		expect(await readProfileExpiry(broken, join(dir, "dd"))).toBeNull();
	});
});
