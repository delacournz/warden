import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FrameworkId } from "../adapters/adapter.types";
import type { Exec } from "../harness/exec";
import type { Footprint } from "./schema";

export type FootprintInput = {
	/** `packages/e2e-bench` */
	packageRoot: string;
	framework: FrameworkId;
	exec: Exec;
	home?: string;
};

const SOURCE_EXT = new Set([".ts", ".yaml", ".yml", ".ad", ".js"]);
const SKIP_DIRS = new Set(["node_modules", "artifacts", ".e2e"]);

/** node_modules entries (relative to the package) a framework needs; global tools need none. */
const PACKAGE_DEPS: Partial<Record<FrameworkId, readonly string[]>> = {
	"tester-army": ["e2e", "@e2e-dev", "agent-device"],
	detox: ["detox", "jest"],
};

type SourceStats = { loc: number; bytes: number };

function extOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot);
}

/** Non-blank lines and bytes of the framework's test sources (ts / yaml / ad / js), skipping deps and artifacts. */
export function sourceStats(dir: string): SourceStats {
	const total: SourceStats = { loc: 0, bytes: 0 };
	const walk = (current: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(current, name);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(full);
			} else if (SOURCE_EXT.has(extOf(name))) {
				total.bytes += stat.size;
				total.loc += readFileSync(full, "utf8")
					.split("\n")
					.filter((l) => l.trim() !== "").length;
			}
		}
	};
	walk(dir);
	return total;
}

/** `du -skL` bytes of one path, or undefined when it does not exist. */
async function duBytes(exec: Exec, path: string): Promise<number | undefined> {
	const r = await exec.run("du", ["-skL", path], { timeoutMs: 60_000 });
	const m = /^(\d+)/.exec(r.stdout.trim());
	return r.code === 0 && m?.[1] !== undefined ? Number(m[1]) * 1024 : undefined;
}

/** Sums `du` over paths; paths that are missing are listed in the notes instead. */
async function sizeOf(exec: Exec, paths: readonly string[], notes: string[]): Promise<number> {
	let sum = 0;
	for (const path of paths) {
		const bytes = await duBytes(exec, path);
		if (bytes === undefined) notes.push(`not found: ${path}`);
		else sum += bytes;
	}
	return sum;
}

/** `/opt/homebrew/Cellar/maestro/2.0.0/libexec/bin/maestro` to `/opt/homebrew/Cellar/maestro/2.0.0`. */
export function cellarDir(resolved: string): string | undefined {
	return /^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/.exec(resolved)?.[1];
}

async function maestroDirs(exec: Exec, home: string, notes: string[]): Promise<string[]> {
	const dirs = [join(home, ".maestro")];
	const bin = exec.which("maestro");
	if (bin === undefined) return dirs;
	const real = await exec.run("readlink", ["-f", bin], { timeoutMs: 5_000 });
	const cellar = real.code === 0 ? cellarDir(real.stdout.trim()) : undefined;
	if (cellar === undefined) notes.push(`maestro binary ${bin} is not a Homebrew cellar install`);
	else dirs.push(cellar);
	return dirs;
}

async function binaryDirs(input: FootprintInput, home: string, notes: string[]): Promise<string[]> {
	const globalModules = join(home, ".bun/install/global/node_modules");
	switch (input.framework) {
		case "maestro":
			return maestroDirs(input.exec, home, notes);
		case "argent":
			return [join(globalModules, "@swmansion/argent")];
		case "agent-device":
			return [join(globalModules, "agent-device")];
		case "warden":
			return [resolve(input.packageRoot, "../e2e/native/dist")];
		case "detox":
			return [join(home, "Library/Detox")];
		case "tester-army":
			return [];
	}
}

/**
 * What adopting a framework costs on disk: lines and bytes of its test sources, the node_modules it needs
 * in this package, and its own binaries. Sizes come from `du` (injected exec); a missing path adds a note.
 */
export async function footprintOf(input: FootprintInput): Promise<Footprint> {
	const home = input.home ?? homedir();
	const notes: string[] = [];
	const source = sourceStats(join(input.packageRoot, "suites", input.framework));
	const deps = (PACKAGE_DEPS[input.framework] ?? []).map((d) => join(input.packageRoot, "node_modules", d));
	const depsBytes = await sizeOf(input.exec, deps, notes);
	const binaryBytes = await sizeOf(input.exec, await binaryDirs(input, home, notes), notes);
	return {
		testSourceLoc: source.loc,
		testSourceBytes: source.bytes,
		depsBytes,
		binaryBytes,
		notes,
	};
}
