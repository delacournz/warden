import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { PodsDeps, PodsEntry, PodsMeta, PodsTarget } from "./pods.types";
import { cloneTree } from "./pods-clone";
import { fixChecksums, leftovers, locksMatch, type RootPair, rewriteRoots } from "./pods-rewrite";
import { podsEntryDir } from "./pods-store";

export function readPodsMeta(deps: PodsDeps, key: string): PodsMeta | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(podsEntryDir(deps.env, key), "meta.json"), "utf8"));
		return isMeta(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isStrings(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isMeta(v: unknown): v is PodsMeta {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	return (
		typeof m.key === "string" &&
		typeof m.root === "string" &&
		typeof m.rawRoot === "string" &&
		isStrings(m.iosDirs) &&
		isStrings(m.iosFiles) &&
		isStrings(m.outside) &&
		isStrings(m.rewrite)
	);
}

/** The spellings of the old root and what each becomes: the real path to the real path, the `git` spelling to the `git` spelling. */
function rootPairs(meta: PodsMeta, target: PodsTarget): RootPair[] {
	const pairs: RootPair[] = [];
	if (meta.root !== target.root.real) pairs.push({ from: meta.root, to: target.root.real });
	if (meta.rawRoot !== meta.root && meta.rawRoot !== target.root.raw)
		pairs.push({ from: meta.rawRoot, to: target.root.raw });
	return pairs;
}

/** Replace `dest` with `src` by rename, the old one set aside until the new one is in. */
function swap(src: string, dest: string, trash: string[]): void {
	mkdirSync(dirname(dest), { recursive: true });
	if (existsSync(dest)) {
		const aside = `${dest}.warden-old-${randomUUID()}`;
		renameSync(dest, aside);
		trash.push(aside);
	}
	renameSync(src, dest);
}

/** Swap the verified staged files into the checkout. */
function applyStaged(meta: PodsMeta, staging: string, target: PodsTarget, trash: string[]): void {
	if (meta.iosDirs.includes(".")) {
		swap(join(staging, "ios"), target.iosAbs, trash);
	} else {
		for (const d of meta.iosDirs) swap(join(staging, "ios", d), join(target.iosAbs, d), trash);
		for (const f of meta.iosFiles) swap(join(staging, "ios", f), join(target.iosAbs, f), trash);
	}
	for (const rel of meta.outside) swap(join(staging, "outside", rel), join(target.root.real, rel), trash);
}

/**
 * Put entry `entry` into the checkout: clone it into a staging dir beside `ios/`, rewrite the cached root to this checkout's,
 * fix the local podspec checksums in both lockfiles, verify, and only then swap it in. A failed step leaves the checkout
 * exactly as it was.
 */
export async function restorePods(deps: PodsDeps, entry: PodsEntry, target: PodsTarget): AsyncResult<void> {
	const meta = readPodsMeta(deps, entry.key);
	if (!meta) return err(`pods cache entry ${entry.key} has no readable meta.json`);
	const dir = podsEntryDir(deps.env, entry.key);
	if (!existsSync(join(dir, "ios"))) return err(`pods cache entry ${entry.key} is missing its ios/ snapshot`);
	const staging = join(dirname(target.iosAbs), `.warden-pods-staging-${randomUUID()}`);
	const trash: string[] = [];
	let mark = deps.now();
	const lap = (phase: string): void => {
		const at = deps.now();
		deps.log(`pods restore ${entry.key.slice(0, 8)}: ${phase} ${at - mark} ms`);
		mark = at;
	};
	try {
		mkdirSync(staging, { recursive: true });
		const ios = await cloneTree(deps, join(dir, "ios"), join(staging, "ios"));
		if (!ios.success) return ios;
		lap("clone ios/");
		if (existsSync(join(dir, "outside"))) {
			const outside = await cloneTree(deps, join(dir, "outside"), join(staging, "outside"));
			if (!outside.success) return outside;
		}
		lap("restore node_modules writes");
		const pairs = rootPairs(meta, target);
		const rewritten = rewriteRoots(staging, meta.rewrite, pairs);
		if (!rewritten.success) return rewritten;
		fixChecksums(join(staging, "ios", "Podfile.lock"), rewritten.data.checksums);
		fixChecksums(join(staging, "ios", "Pods", "Manifest.lock"), rewritten.data.checksums);
		lap(`rewrite ${meta.rewrite.length} files + checksums`);
		if (!locksMatch(join(staging, "ios"))) return err("restored Podfile.lock and Pods/Manifest.lock differ");
		const stale = leftovers(staging, meta.rewrite, pairs);
		if (stale.length > 0) return err(`restored files still hold the old root: ${stale.slice(0, 3).join(", ")}`);
		lap("verify");

		applyStaged(meta, staging, target, trash);
		lap("swap");
		return ok(undefined);
	} catch (error) {
		return err(error);
	} finally {
		rmSync(staging, { recursive: true, force: true });
		for (const t of trash) rmSync(t, { recursive: true, force: true });
		if (trash.length > 0) lap("remove replaced files");
	}
}
