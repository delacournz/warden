import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { DEFAULT_BUILD_COMMAND } from "../builds/builds.defaults";
import type { Project } from "../builds/config";
import { computeFingerprint } from "../builds/fingerprint";
import { type Exec, execError } from "../exec";
import {
	PODS_ENV_NAMES,
	PODS_ENV_PREFIXES,
	PODS_KEY_VERSION,
	PODS_MUTATED_BY_INSTALL,
	PODS_PROBE_TIMEOUT_MS,
} from "./pods.defaults";
import type { Env, PodsMode, PodsRoot } from "./pods.types";

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** The git toplevel of `dir`; undefined outside a git checkout. */
export async function resolveRoot(exec: Exec, dir: string): Promise<PodsRoot | undefined> {
	const res = await exec(["git", "rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: PODS_PROBE_TIMEOUT_MS });
	const raw = res.stdout.trim();
	if (res.exitCode !== 0 || raw === "") return undefined;
	try {
		return { raw, real: realpathSync(raw) };
	} catch {
		return undefined;
	}
}

/** cng when `iosDir` is git-ignored and the app is Expo; committed otherwise. */
export async function detectMode(
	exec: Exec,
	projectRoot: string,
	iosDir: string,
	framework: "expo" | "react-native"
): Promise<PodsMode> {
	if (framework !== "expo") return "committed";
	const res = await exec(["git", "check-ignore", "-q", `${iosDir}/`], {
		cwd: projectRoot,
		timeoutMs: PODS_PROBE_TIMEOUT_MS,
	});
	return res.exitCode === 0 ? "cng" : "committed";
}

/** The env a Podfile may read, as `NAME=value` lines (sorted). */
export function podsEnvLines(env: Env): string[] {
	return Object.keys(env)
		.filter(
			(name) =>
				env[name] !== undefined && (PODS_ENV_NAMES.includes(name) || PODS_ENV_PREFIXES.some((p) => name.startsWith(p)))
		)
		.sort()
		.map((name) => `env.${name}=${env[name]}`);
}

export type PodsKeyInput = {
	/** realpath */
	projectRoot: string;
	root: PodsRoot;
	/** relative to the project root */
	iosDir: string;
	mode: PodsMode;
	podVersion: string;
	/** env `pod install` runs with beyond the caller's (the prebuilt React Native vars) */
	planEnv: Env;
	/** `planPrebuiltRn`'s salt, when the build is effectively prebuilt */
	planSalt?: string;
};

export type PodsKey = { key: string; xcodeVersion: string; projectRel: string };

async function probe(exec: Exec, argv: readonly string[], cwd: string): AsyncResult<string> {
	const res = await exec(argv, { cwd, timeoutMs: PODS_PROBE_TIMEOUT_MS });
	if (res.exitCode !== 0) return err(`\`${argv.join(" ")}\` failed: ${execError(argv, res)}`);
	return ok(res.stdout.trim().replace(/\s*\n\s*/g, " / "));
}

function hashFile(path: string): string {
	return existsSync(path) ? sha256(readFileSync(path)) : "none";
}

/** `git ls-files -s` of the tracked `ios/` files outside `Pods/` and `build/`: pod install's own writes by blob, the rest by bytes. */
async function trackedLines(exec: Exec, projectRoot: string, iosDir: string): AsyncResult<string[]> {
	const argv = ["git", "ls-files", "-s", "-z", "--", iosDir];
	const res = await exec(argv, { cwd: projectRoot, timeoutMs: PODS_PROBE_TIMEOUT_MS });
	if (res.exitCode !== 0) return err(`cannot list tracked files: ${execError(argv, res)}`);
	const skip = [`${iosDir}/Pods/`, `${iosDir}/build/`];
	const lines: string[] = [];
	for (const entry of res.stdout.split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const blob = entry.slice(0, tab).split(" ")[1] ?? "";
		const path = entry.slice(tab + 1);
		if (skip.some((s) => path.startsWith(s))) continue;
		const content = PODS_MUTATED_BY_INSTALL.test(path) ? `blob:${blob}` : hashFile(join(projectRoot, path));
		lines.push(`tracked.${path}=${content}`);
	}
	return ok(lines.sort());
}

/**
 * The cache key of a pods install: tool versions, host arch, mode, project location, the native fingerprint, the
 * prebuilt-RN salt and the env a Podfile reads; committed mode adds the Podfile, its properties and every tracked `ios/` file.
 * An input that is unsure goes in: a wrong hit is worse than a miss. `ios/project.pbxproj` of a CNG app is never an input
 * (`expo prebuild` mints random ids), only the fingerprint is, and that is computed before prebuild.
 */
export async function computePodsKey(deps: { exec: Exec; env: Env }, input: PodsKeyInput): AsyncResult<PodsKey> {
	const { exec } = deps;
	const cwd = input.projectRoot;
	const xcode = await probe(exec, ["xcodebuild", "-version"], cwd);
	if (!xcode.success) return xcode;
	const arch = await probe(exec, ["uname", "-m"], cwd);
	if (!arch.success) return arch;
	const project: Project = {
		name: "pods",
		root: input.projectRoot,
		bundleId: {},
		build: { ...DEFAULT_BUILD_COMMAND },
		buildConfiguration: "Debug",
		cacheDirs: [],
		framework: "expo",
		origin: "config",
		source: "repo",
	};
	const native = await computeFingerprint(exec, project, "ios");
	if (!native.success) return native;
	const projectRel = relative(input.root.real, input.projectRoot) || ".";
	const lines = [
		PODS_KEY_VERSION,
		`pod=${input.podVersion}`,
		`xcode=${xcode.data}`,
		`arch=${arch.data}`,
		`mode=${input.mode}`,
		`project=${projectRel}`,
		`ios=${input.iosDir}`,
		`native=${native.data}`,
		`salt=${input.planSalt ?? "none"}`,
		...podsEnvLines({ ...deps.env, ...input.planEnv }),
	];
	if (input.mode === "committed") {
		const iosAbs = join(input.projectRoot, input.iosDir);
		lines.push(
			`podfile=${hashFile(join(iosAbs, "Podfile"))}`,
			`podfile.properties=${hashFile(join(iosAbs, "Podfile.properties.json"))}`
		);
		const tracked = await trackedLines(exec, input.projectRoot, input.iosDir);
		if (!tracked.success) return tracked;
		lines.push(...tracked.data);
	}
	return ok({ key: sha256(lines.join("\n")).slice(0, 40), xcodeVersion: xcode.data, projectRel });
}
