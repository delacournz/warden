import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { execError } from "../exec";
import { PODS_SNAPSHOT_EXCLUDE_DIRS } from "./pods.defaults";
import type { PodsDeps, PodsEntry, PodsMeta, PodsTarget } from "./pods.types";
import { cloneTree } from "./pods-clone";
import { insertPodsEntry, podsEntryDir, podsRoot, treeSize } from "./pods-store";

export type SnapshotInput = {
	key: string;
	target: PodsTarget;
	/** a file made just before pod install ran: what is newer than it, pod install wrote */
	marker: string;
	podVersion: string;
	xcodeVersion: string;
};

async function findLines(deps: PodsDeps, argv: readonly string[], cwd: string): AsyncResult<string[]> {
	const res = await deps.exec(argv, { cwd });
	if (res.exitCode !== 0) return err(execError(argv, res));
	return ok(res.stdout.split("\n").filter((l) => l !== ""));
}

/** Files under the `node_modules` dirs pod install may touch (the project's and the repo's) written since `marker`. */
async function outsideWrites(deps: PodsDeps, input: SnapshotInput): AsyncResult<string[]> {
	const { target } = input;
	const dirs = [...new Set([join(target.projectRoot, "node_modules"), join(target.root.real, "node_modules")])].filter(
		(d) => existsSync(d)
	);
	if (dirs.length === 0) return ok([]);
	const excludes = PODS_SNAPSHOT_EXCLUDE_DIRS.flatMap((d) => ["-not", "-path", `*/${d}/*`]);
	const found = await findLines(
		deps,
		["find", "-P", ...dirs, "-type", "f", "-newer", input.marker, ...excludes],
		target.root.real
	);
	if (!found.success) return found;
	return ok(found.data.map((abs) => relative(target.root.real, abs)).filter((rel) => !rel.startsWith("..")));
}

/** Files of `ios/` outside `Pods/` and `build/` written since `marker`, plus the lockfile (always: its checksums get fixed on restore). */
async function iosWrites(deps: PodsDeps, input: SnapshotInput): AsyncResult<string[]> {
	const { target } = input;
	const found = await findLines(
		deps,
		["find", ".", "-type", "f", "-newer", input.marker, "-not", "-path", "./Pods/*", "-not", "-path", "./build/*"],
		target.iosAbs
	);
	if (!found.success) return found;
	const files = new Set(found.data.map((p) => p.replace(/^\.\//, "")));
	if (existsSync(join(target.iosAbs, "Podfile.lock"))) files.add("Podfile.lock");
	return ok([...files].sort());
}

async function copyInto(deps: PodsDeps, src: string, dst: string): AsyncResult<void> {
	mkdirSync(dirname(dst), { recursive: true });
	return cloneTree(deps, src, dst);
}

/** Text files holding the checkout root, relative to `staging`. */
async function rootHolders(deps: PodsDeps, staging: string, target: PodsTarget): AsyncResult<string[]> {
	const spellings = [...new Set([target.root.real, target.root.raw])];
	const argv = ["grep", "-rIlF", "--null", ...spellings.flatMap((s) => ["-e", s]), "ios", "outside"];
	const res = await deps.exec(argv, { cwd: staging });
	if (res.exitCode > 1) return err(execError(argv, res));
	const files = res.stdout
		.split("\0")
		.map((f) => f.trim())
		.filter((f) => f !== "")
		.filter((f) => lstatSync(join(staging, f), { throwIfNoEntry: false })?.isFile());
	return ok(files.sort());
}

type Selection = { iosDirs: string[]; iosFiles: string[]; outside: string[] };

/** Committed mode: `Pods/`, `build/` and the individual `ios/` files pod install wrote. */
async function cloneCommitted(
	deps: PodsDeps,
	input: SnapshotInput,
	staging: string
): AsyncResult<Omit<Selection, "outside">> {
	const { target } = input;
	mkdirSync(join(staging, "ios"), { recursive: true });
	const iosDirs = ["Pods", "build"].filter((d) => existsSync(join(target.iosAbs, d)));
	for (const d of iosDirs) {
		const cloned = await cloneTree(deps, join(target.iosAbs, d), join(staging, "ios", d));
		if (!cloned.success) return cloned;
	}
	const files = await iosWrites(deps, input);
	if (!files.success) return err(`cannot find the files pod install wrote: ${files.error}`);
	for (const f of files.data) {
		const cloned = await copyInto(deps, join(target.iosAbs, f), join(staging, "ios", f));
		if (!cloned.success) return cloned;
	}
	return ok({ iosDirs, iosFiles: files.data });
}

/** Clone what pod install produced into `staging/{ios,outside}`: all of `ios/` (cng) or only what it wrote (committed). */
async function cloneSelection(deps: PodsDeps, input: SnapshotInput, staging: string): AsyncResult<Selection> {
	const { target } = input;
	mkdirSync(join(staging, "outside"), { recursive: true });
	const outside = await outsideWrites(deps, input);
	if (!outside.success) return err(`cannot find the files pod install wrote: ${outside.error}`);
	let iosDirs: string[] = ["."];
	let iosFiles: string[] = [];
	if (target.mode === "cng") {
		const cloned = await cloneTree(deps, target.iosAbs, join(staging, "ios"));
		if (!cloned.success) return cloned;
	} else {
		const committed = await cloneCommitted(deps, input, staging);
		if (!committed.success) return committed;
		({ iosDirs, iosFiles } = committed.data);
	}
	for (const rel of outside.data) {
		const cloned = await copyInto(deps, join(target.root.real, rel), join(staging, "outside", rel));
		if (!cloned.success) return cloned;
	}
	return ok({ iosDirs, iosFiles, outside: outside.data });
}

/**
 * Store what `pod install` just produced as the entry for `key`: clone `ios/` (committed mode: only what the install wrote)
 * and the `node_modules` files it wrote into `$WARDEN_HOME/pods/.staging-*`, record which text files hold the root, then
 * move it into place with its sqlite row in one transaction. Never touches the checkout.
 */
export async function snapshotPods(deps: PodsDeps, input: SnapshotInput): AsyncResult<PodsEntry> {
	const { target } = input;
	const home = podsRoot(deps.env);
	mkdirSync(home, { recursive: true });
	const staging = join(home, `.staging-${randomUUID()}`);
	try {
		const copied = await cloneSelection(deps, input, staging);
		if (!copied.success) return copied;
		const { iosDirs, iosFiles, outside } = copied.data;
		const rewrite = await rootHolders(deps, staging, target);
		if (!rewrite.success) return rewrite;
		const now = deps.now();
		const entry: PodsEntry = {
			key: input.key,
			mode: target.mode,
			root: target.root.real,
			projectRel: target.projectRel,
			sizeBytes: treeSize(staging),
			createdAt: now,
			lastUsedAt: now,
			podVersion: input.podVersion,
			xcodeVersion: input.xcodeVersion,
		};
		const meta: PodsMeta = {
			key: entry.key,
			mode: entry.mode,
			root: target.root.real,
			rawRoot: target.root.raw,
			projectRel: target.projectRel,
			iosDir: target.iosDir,
			createdAt: now,
			podVersion: input.podVersion,
			xcodeVersion: input.xcodeVersion,
			sizeBytes: entry.sizeBytes,
			iosDirs,
			iosFiles,
			outside,
			rewrite: rewrite.data,
		};
		writeFileSync(join(staging, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
		const dest = podsEntryDir(deps.env, input.key);
		deps.store.transaction(() => {
			rmSync(dest, { recursive: true, force: true });
			renameSync(staging, dest);
			insertPodsEntry(deps.store, entry);
		});
		return ok(entry);
	} catch (error) {
		return err(error);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
