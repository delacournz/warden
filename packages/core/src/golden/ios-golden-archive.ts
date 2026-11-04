/**
 * Golden iOS images carried between machines (CI runners): `exportGolden` copies the golden's device dir into
 * `<dir>/<golden name>/` with a manifest, `importGoldens` registers each archive whose key this machine would build.
 *
 * An iOS golden is only a CoreSimulator device (warden's store holds no golden state): its name carries the key, its
 * dir holds the first-booted `data/`. Import never copies a device dir into the device set behind CoreSimulator's
 * back (it would not see it until `CoreSimulatorService` restarts, which kills every booted sim). It does what
 * `simctl clone` does instead: `simctl create` registers a fresh `-wip` device of the same type and runtime, the
 * archived dir replaces its contents (all but `device.plist`), the migration record is checked, and only then is it
 * renamed to the golden's name, all under the `golden:ios` lease. Anything that does not match is skipped, and the
 * next claim builds the golden as before.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { withBuildLock } from "../builds/lock";
import type { Exec } from "../exec";
import { IOS_TIMEOUTS } from "../providers/ios";
import { GOLDEN_RECIPE, goldenKey, goldenName, migrationDone, olderRecipeNames, planGolden, wipName } from "./golden";
import {
	allSims,
	deleteSims,
	discard,
	ensureLocked,
	GOLDEN_LOCK_KEY,
	type GoldenDeps,
	type GoldenTarget,
	lockDeps,
	log,
	MUTATE_TIMEOUT_MS,
	readGoldenTarget,
	readMigration,
	simctl,
	simDeviceDir,
} from "./ios-golden";

export const GOLDEN_MANIFEST = "golden.json";
/** The archived device dir (everything but `device.plist`) inside `<dir>/<golden name>/`. */
const DEVICE_DIR = "device";
/** CoreSimulator's own record of the device (udid, name, type, runtime): the new device keeps its own. */
const DEVICE_PLIST = "device.plist";

const manifestSchema = z.object({
	version: z.literal(1),
	name: z.string(),
	key: z.string(),
	recipe: z.number(),
	profile: z.string(),
	/** the `--runtime` the golden was ensured with (absent: the latest, as a claim resolves it) */
	runtime: z.string().optional(),
	udid: z.string(),
	/** `$HOME` of the exporting machine: absolute symlinks into the device dir start with it */
	home: z.string().optional(),
	xcodeBuild: z.string(),
	runtimeId: z.string(),
	runtimeBuild: z.string(),
	deviceType: z.string(),
	exportedAt: z.number(),
});

export type GoldenManifest = z.infer<typeof manifestSchema>;

/** What a golden of this machine is keyed on: what a CI cache key is made of. */
export type GoldenInfo = GoldenTarget & { key: string; name: string; recipe: number };

export type ExportedGolden = { name: string; key: string; udid: string; built: boolean; path: string };

/** One archive `importGoldens` looked at. */
export type ImportedGolden =
	| { name: string; profile: string; imported: true; udid: string }
	| { name: string; profile?: string; imported: false; udid?: string; reason: string };

function info(target: GoldenTarget): GoldenInfo {
	const key = goldenKey(target);
	return { ...target, key, name: goldenName(target.profile, key), recipe: GOLDEN_RECIPE };
}

/** The key and name of this machine's golden for `profile` (no build, no lease). */
export async function goldenInfo(deps: GoldenDeps, profile: string, runtime?: string): AsyncResult<GoldenInfo> {
	const target = await readGoldenTarget(deps, profile, runtime);
	return target.success ? ok(info(target.data)) : target;
}

/** APFS clone (`cp -c`, near-free on one volume); a plain copy (symlinks verbatim) where the volume cannot clone. */
async function copyTree(exec: Exec, src: string, dst: string): AsyncResult<void> {
	rmSync(dst, { recursive: true, force: true });
	mkdirSync(dirname(dst), { recursive: true });
	const clone = await exec(["cp", "-c", "-R", src, dst]);
	if (clone.exitCode === 0) return ok(undefined);
	rmSync(dst, { recursive: true, force: true });
	try {
		cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
		return ok(undefined);
	} catch (error) {
		return err(`copying ${src} → ${dst}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Copy every entry of `from` but `device.plist` into `to`, replacing what is there. */
async function copyDeviceEntries(exec: Exec, from: string, to: string): AsyncResult<void> {
	mkdirSync(to, { recursive: true });
	for (const name of readdirSync(from)) {
		if (name === DEVICE_PLIST) continue;
		const copied = await copyTree(exec, join(from, name), join(to, name));
		if (!copied.success) return copied;
	}
	return ok(undefined);
}

/** Stage `<final>.staging` (device entries + manifest) and move it over `final`; the staging dir always goes. */
async function writeArchive(exec: Exec, source: string, final: string, manifest: GoldenManifest): AsyncResult<void> {
	const staging = `${final}.staging`;
	rmSync(staging, { recursive: true, force: true });
	try {
		const copied = await copyDeviceEntries(exec, source, join(staging, DEVICE_DIR));
		if (!copied.success) return copied;
		writeFileSync(join(staging, GOLDEN_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
		rmSync(final, { recursive: true, force: true });
		renameSync(staging, final);
		return ok(undefined);
	} catch (error) {
		return err(`exporting ${manifest.name}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Copy the golden of `profile` (built first when missing) into `<dir>/<golden name>/`: the device dir without
 * `device.plist`, plus `golden.json`. Staged beside the final dir and moved in, so a failure leaves the old archive.
 */
export async function exportGolden(
	deps: GoldenDeps,
	profile: string,
	runtime: string | undefined,
	dir: string
): AsyncResult<ExportedGolden> {
	const target = await readGoldenTarget(deps, profile, runtime);
	if (!target.success) return target;
	const golden = info(target.data);
	return withBuildLock(lockDeps(deps), GOLDEN_LOCK_KEY, async () => {
		const ensured = await ensureLocked(deps, target.data);
		if (!ensured.success) return ensured;
		const { udid, built } = ensured.data;
		const source = simDeviceDir(deps.env, udid);
		if (!existsSync(source)) return err(`golden ${golden.name}: no device dir at ${source}`);
		const final = join(dir, golden.name);
		const written = await writeArchive(deps.exec, source, final, {
			version: 1,
			name: golden.name,
			key: golden.key,
			recipe: golden.recipe,
			profile,
			...(runtime !== undefined ? { runtime } : {}),
			udid,
			...(deps.env.HOME !== undefined ? { home: deps.env.HOME } : {}),
			xcodeBuild: golden.xcodeBuild,
			runtimeId: golden.runtimeId,
			runtimeBuild: golden.runtimeBuild,
			deviceType: golden.deviceType,
			exportedAt: deps.now(),
		});
		if (!written.success) return written;
		log(deps, `exported ${golden.name} → ${final}`);
		return ok({ name: golden.name, key: golden.key, udid, built, path: final });
	});
}

function readManifest(file: string): Result<GoldenManifest> {
	try {
		const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
		return parsed.success ? ok(parsed.data) : err(parsed.error.message);
	} catch (error) {
		return err(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Absolute symlinks into the exporting device's dirs (`…/Devices/<udid>/…`, `…/Logs/CoreSimulator/<udid>`) point at
 * the new device instead. `simctl clone` leaves them at the source device; re-pointing keeps them alive here.
 */
function repointLinks(root: string, from: { udid: string; home?: string }, to: { udid: string; home: string }): void {
	const rewrite = (target: string): string => {
		if (!target.startsWith("/") || !target.includes(`/CoreSimulator/`) || !target.includes(from.udid)) return target;
		const homed =
			from.home !== undefined && target.startsWith(`${from.home}/`)
				? `${to.home}${target.slice(from.home.length)}`
				: target;
		return homed.replaceAll(from.udid, to.udid);
	};
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				const target = readlinkSync(path);
				const next = rewrite(target);
				if (next !== target) {
					rmSync(path, { force: true });
					symlinkSync(next, path);
				}
			} else if (entry.isDirectory()) walk(path);
		}
	};
	walk(root);
}

/** Create the `-wip` device, swap the archive in, check the migration, rename. Caller holds the golden lock. */
async function registerArchive(
	deps: GoldenDeps,
	archive: string,
	manifest: GoldenManifest,
	target: GoldenTarget
): AsyncResult<ImportedGolden> {
	const key = goldenKey(target);
	const name = goldenName(target.profile, key);
	const sims = await allSims(deps);
	if (!sims.success) return sims;
	const plan = planGolden(sims.data, target.profile, key, olderRecipeNames(target.profile, target));
	if (plan.kind === "reuse") {
		return ok({
			name,
			profile: target.profile,
			imported: false,
			udid: plan.sim.udid,
			reason: "already on this machine",
		});
	}
	const pruned = await deleteSims(deps, plan.stale);
	if (!pruned.success) return pruned;
	const created = await simctl(
		deps,
		["create", wipName(target.profile, key), target.deviceType, target.runtimeId],
		IOS_TIMEOUTS.createMs
	);
	if (!created.success) return created;
	const udid = created.data.trim();
	const deviceDir = simDeviceDir(deps.env, udid);
	const skip = async (reason: string): AsyncResult<ImportedGolden> => {
		await discard(deps, udid);
		rmSync(deviceDir, { recursive: true, force: true });
		log(deps, `not importing ${name}: ${reason}`);
		return ok({ name, profile: target.profile, imported: false, reason });
	};
	const copied = await copyDeviceEntries(deps.exec, join(archive, DEVICE_DIR), deviceDir);
	if (!copied.success) return skip(copied.error);
	try {
		repointLinks(deviceDir, manifest, { udid, home: deps.env.HOME ?? "~" });
	} catch (error) {
		return skip(`re-pointing symlinks: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!migrationDone(await readMigration(deps, udid), target.runtimeBuild)) {
		return skip("the archived device never finished its first-boot data migration");
	}
	const renamed = await simctl(deps, ["rename", udid, name], MUTATE_TIMEOUT_MS);
	if (!renamed.success) return skip(renamed.error);
	log(deps, `imported ${name} (${udid})`);
	return ok({ name, profile: target.profile, imported: true, udid });
}

/** Check one `<dir>/<name>/` against this machine's key for its profile, and register it when it matches. */
async function importOne(deps: GoldenDeps, archive: string, entry: string): AsyncResult<ImportedGolden> {
	const manifest = readManifest(join(archive, GOLDEN_MANIFEST));
	if (!manifest.success) return ok({ name: entry, imported: false, reason: `unreadable ${GOLDEN_MANIFEST}` });
	const m = manifest.data;
	const skipped = (reason: string): ImportedGolden => ({ name: m.name, profile: m.profile, imported: false, reason });
	if (!existsSync(join(archive, DEVICE_DIR))) return ok(skipped(`no ${DEVICE_DIR}/ dir`));
	const target = await readGoldenTarget(deps, m.profile, m.runtime);
	if (!target.success) return ok(skipped(`no ${m.profile} target on this machine: ${target.error}`));
	const mine = info(target.data);
	if (m.key !== mine.key || m.name !== mine.name) {
		return ok(
			skipped(
				`archive is for Xcode ${m.xcodeBuild}, ${m.runtimeId} (${m.runtimeBuild}), recipe ${m.recipe}; this machine's golden is ${mine.name} (Xcode ${mine.xcodeBuild}, ${mine.runtimeId} (${mine.runtimeBuild}), recipe ${mine.recipe})`
			)
		);
	}
	return withBuildLock(lockDeps(deps), GOLDEN_LOCK_KEY, () => registerArchive(deps, archive, m, target.data));
}

/**
 * Register every golden archived under `dir` (`exportGolden`'s layout) whose key this machine would build. A missing
 * dir (a CI cache miss), a stale or broken archive, or a golden already here is skipped with the reason; the golden is
 * then built on first claim, as without an archive.
 */
export async function importGoldens(deps: GoldenDeps, dir: string): AsyncResult<ImportedGolden[]> {
	if (!existsSync(dir)) return ok([]);
	const results: ImportedGolden[] = [];
	const entries = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, GOLDEN_MANIFEST)))
		.map((e) => e.name)
		.sort();
	for (const entry of entries) {
		const one = await importOne(deps, join(dir, entry), entry);
		if (!one.success) return one;
		results.push(one.data);
	}
	return ok(results);
}
