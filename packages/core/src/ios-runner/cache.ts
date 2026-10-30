import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../exec";
import { runnerRoot } from "./stage";

/** Rebuild when the provisioning profile ends within this long (free teams get 7-day profiles). */
export const PROFILE_MARGIN_MS = 24 * 60 * 60 * 1000;
/** When the profile's expiry cannot be read, assume a free team's 7 days minus a day of margin from the build. */
export const UNKNOWN_PROFILE_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;

/** `meta.json` next to `dd/` in a cache directory. */
export type RunnerMeta = {
	/** every phone the profile was built for (a new UDID needs a build: `-destination id=` registers it) */
	udids: string[];
	/** earliest expiry (ms since epoch) of the profiles embedded in the products; null = unreadable */
	profileExpires: number | null;
	builtAt: number;
	bundleId: string;
};

export type RebuildReason = "none" | "new_udid" | "profile_expiring" | "bundle_id" | "missing";

/** `<home>/ios-runner/<team>/<xcodeBuild>-<srcHash>`: holds `dd/` (derived data) and `meta.json`. */
export function runnerCacheDir(home: string, team: string, xcodeBuild: string, srcHash: string): string {
	return join(runnerRoot(home), team, `${xcodeBuild}-${srcHash}`);
}

export function derivedDataDir(cacheDir: string): string {
	return join(cacheDir, "dd");
}

const META_FILE = "meta.json";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** The cache's meta, or undefined when absent or not ours (a half-written file never reads as a hit). */
export function readRunnerMeta(cacheDir: string): RunnerMeta | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(cacheDir, META_FILE), "utf8"));
		if (typeof raw !== "object" || raw === null) return undefined;
		const { udids, profileExpires, builtAt, bundleId } = raw as Record<string, unknown>;
		if (!isStringArray(udids) || typeof builtAt !== "number" || typeof bundleId !== "string") return undefined;
		if (profileExpires !== null && typeof profileExpires !== "number") return undefined;
		return { udids, profileExpires, builtAt, bundleId };
	} catch {
		return undefined;
	}
}

/** Written last, after the build, through a rename: the meta is what makes a build count. */
export function writeRunnerMeta(cacheDir: string, meta: RunnerMeta): void {
	mkdirSync(cacheDir, { recursive: true });
	const tmp = join(cacheDir, `${META_FILE}.tmp-${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(meta, null, "\t")}\n`);
	renameSync(tmp, join(cacheDir, META_FILE));
}

/** The `.xctestrun` `build-for-testing` wrote under `Build/Products`. */
export function findXctestrun(derivedData: string): string | undefined {
	const products = join(derivedData, "Build", "Products");
	if (!existsSync(products)) return undefined;
	const runs = readdirSync(products)
		.filter((f) => f.endsWith(".xctestrun"))
		.sort();
	const run = runs.find((f) => f.startsWith("WardenRunner")) ?? runs[0];
	return run === undefined ? undefined : join(products, run);
}

export type ReuseDecision = { reuse: true } | { reuse: false; because: RebuildReason };

/** Can the cached build serve `udid` now? */
export function decideReuse(o: {
	meta: RunnerMeta | undefined;
	xctestrun: string | undefined;
	udid: string;
	bundleId: string;
	now: number;
}): ReuseDecision {
	const { meta } = o;
	if (meta === undefined) return { reuse: false, because: "none" };
	if (meta.bundleId !== o.bundleId) return { reuse: false, because: "bundle_id" };
	if (o.xctestrun === undefined) return { reuse: false, because: "missing" };
	if (!meta.udids.includes(o.udid)) return { reuse: false, because: "new_udid" };
	const expires = meta.profileExpires ?? meta.builtAt + UNKNOWN_PROFILE_LIFETIME_MS;
	if (expires - o.now < PROFILE_MARGIN_MS) return { reuse: false, because: "profile_expiring" };
	return { reuse: true };
}

/** `<key>ExpirationDate</key><date>2026-11-05T01:02:03Z</date>` of a decoded provisioning profile. */
export function parseProfileExpiry(plist: string): number | undefined {
	const m = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(plist);
	const ms = m?.[1] === undefined ? Number.NaN : Date.parse(m[1]);
	return Number.isNaN(ms) ? undefined : ms;
}

/** Paths of the `embedded.mobileprovision` of every app `build-for-testing` produced (host app and test runner app). */
export function embeddedProfiles(derivedData: string): string[] {
	const products = join(derivedData, "Build", "Products");
	if (!existsSync(products)) return [];
	const found: string[] = [];
	for (const config of readdirSync(products)) {
		if (!config.endsWith("-iphoneos")) continue;
		for (const app of readdirSync(join(products, config))) {
			const profile = join(products, config, app, "embedded.mobileprovision");
			if (app.endsWith(".app") && existsSync(profile)) found.push(profile);
		}
	}
	return found.sort();
}

/** The earliest expiry among the built apps' profiles (`security cms -D`), null when none can be read. */
export async function readProfileExpiry(exec: Exec, derivedData: string): Promise<number | null> {
	let earliest: number | null = null;
	for (const profile of embeddedProfiles(derivedData)) {
		const decoded = await exec(["security", "cms", "-D", "-i", profile]);
		if (decoded.exitCode !== 0) continue;
		const expires = parseProfileExpiry(decoded.stdout);
		if (expires !== undefined && (earliest === null || expires < earliest)) earliest = expires;
	}
	return earliest;
}
