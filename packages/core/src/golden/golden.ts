/**
 * Golden iOS simulators: one fully first-booted, settled, shut-down device per (Xcode build,
 * runtime, device type, recipe). New pool devices are `simctl clone`d from it instead of paying a
 * first boot (Apple logo + data migration): measured on salient e2e, fresh create + first boot
 * 146–239 s vs clone 3.7 s + boot 11.9 s, ~30 MB APFS copy-on-write instead of ~1.5 GB.
 *
 * Pure half: key, names, staleness plan, parsers. Side effects live in `ios-golden.ts`.
 */
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { SimctlSim } from "../sims/list";

/**
 * Bump when what building a golden does to the device changes, so existing goldens go stale.
 * 2: `AutomationEnabled` written in the golden (16-7).
 */
export const GOLDEN_RECIPE = 2;
export const GOLDEN_PREFIX = "warden-golden";

export type GoldenInputs = { xcodeBuild: string; runtimeId: string; runtimeBuild: string; deviceType: string };

/** 10 hex chars of sha256 over everything that makes one golden unusable for another. */
export function goldenKey(inputs: GoldenInputs, recipe: number = GOLDEN_RECIPE): string {
	const material = [inputs.xcodeBuild, inputs.runtimeId, inputs.runtimeBuild, inputs.deviceType, `r${recipe}`].join(
		"|"
	);
	return new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 10);
}

/**
 * `warden-golden-<profile>-<key>[-r<recipe>]`. The recipe is in the name (from recipe 2) as well as in
 * the key so two warden versions on one machine can tell each other's goldens apart: a recipe-1 warden
 * only recognises (and prunes) names without the suffix, and this one never prunes a newer recipe's.
 */
export const goldenName = (profile: string, key: string, recipe: number = GOLDEN_RECIPE) =>
	`${GOLDEN_PREFIX}-${profile}-${key}${recipe > 1 ? `-r${recipe}` : ""}`;
/** Built under this name and renamed only once shut down + verified, so a half-built golden is never cloned. */
export const wipName = (profile: string, key: string, recipe: number = GOLDEN_RECIPE) =>
	`${goldenName(profile, key, recipe)}-wip`;

/** The names this target's golden had under every older recipe (a recipe-1 warden may still use one). */
export function olderRecipeNames(profile: string, inputs: GoldenInputs, recipe: number = GOLDEN_RECIPE): string[] {
	return Array.from({ length: Math.max(0, recipe - 1) }, (_, i) =>
		goldenName(profile, goldenKey(inputs, i + 1), i + 1)
	);
}

export function isGoldenName(name: string): boolean {
	return name.startsWith(`${GOLDEN_PREFIX}-`);
}

export type GoldenPlan = { kind: "reuse"; sim: SimctlSim; stale: SimctlSim[] } | { kind: "create"; stale: SimctlSim[] };

/**
 * Goldens of `profile` (`warden-golden-<profile>-<10 hex>[-r<recipe>][-wip]`): the first available one
 * named for `key` is reused; every other one of this profile (older key, unavailable runtime, leftover
 * wip, duplicate) is stale, except a newer recipe's (another warden version's, never ours to delete)
 * and the first available golden of each name in `keep` (an older recipe's golden of this target).
 * Goldens of other profiles are left alone.
 */
export function planGolden(
	sims: SimctlSim[],
	profile: string,
	key: string,
	keep: readonly string[] = [],
	recipe: number = GOLDEN_RECIPE
): GoldenPlan {
	const pattern = new RegExp(
		`^${GOLDEN_PREFIX}-${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{10}(?:-r(\\d+))?(-wip)?$`
	);
	const mine = sims.filter((s) => {
		const match = pattern.exec(s.name);
		return match !== null && Number(match[1] ?? 1) <= recipe;
	});
	const current = mine.find((s) => s.name === goldenName(profile, key, recipe) && s.isAvailable);
	const kept = new Set(current ? [current] : []);
	for (const name of keep) {
		const sim = mine.find((s) => s.name === name && s.isAvailable);
		if (sim) kept.add(sim);
	}
	const stale = mine.filter((s) => !kept.has(s));
	return current ? { kind: "reuse", sim: current, stale } : { kind: "create", stale };
}

export function parseXcodeBuild(stdout: string): Result<string> {
	const match = /^Build version (\S+)$/m.exec(stdout);
	return match?.[1] ? ok(match[1]) : err(`unexpected \`xcodebuild -version\` output: ${stdout.trim()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `plutil -convert json` of the device's `data/Library/Preferences/com.apple.migration.plist`.
 * `DMLastMigrationResults` is written only once the first-boot data migration has finished; a golden
 * shut down before that hands every clone the whole migration again (215–277 s per clone measured).
 * `bootstatus -b` can return before it's done, so this is the real gate.
 */
export function migrationDone(plistJson: string, runtimeBuild: string): boolean {
	try {
		const data: unknown = JSON.parse(plistJson);
		const last = isRecord(data) ? data.DMLastMigrationResults : undefined;
		return isRecord(last) && last.success === true && last.buildVersion === runtimeBuild;
	} catch {
		return false;
	}
}

export type SettleRule = { maxCpu: number; window: number };

/** Settled = the last `window` CPU samples (summed %CPU of the sim's processes) all under `maxCpu`. */
export function isSettled(samples: number[], rule: SettleRule): boolean {
	return samples.length >= rule.window && samples.slice(-rule.window).every((cpu) => cpu < rule.maxCpu);
}
