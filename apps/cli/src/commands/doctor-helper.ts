import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSimctlDevices } from "@delacour/warden-core/providers/ios";
import { wardenHome } from "@delacour/warden-core/store";
import { locateHelper } from "@delacour/warden-e2e/driver/ios/locate-helper";
import type { CommandContext } from "../context";
import { HELPER_MANIFEST, HELPER_TARGET, type HelperInfo, parseHelperManifest } from "../npm/helper";
import { type BuildInfo, currentBuild } from "../update/build-info";
import type { DoctorCheck } from "./doctor";

/** `--health` is a one-shot: it must answer well inside this, or the check says so. */
const HEALTH_TIMEOUT_MS = 5_000;

/** Outside world for the helper checks, injectable for tests. */
export type HelperDeps = {
	platform: string;
	arch: string;
	/** the running warden (a compiled one ships the helper next to itself) */
	execPath: string;
	/** `packages/e2e/src/driver/ios` of a source checkout, anchors the `native/dist` lookup */
	importDir: string;
	version: string;
	exists: (path: string) => boolean;
	realpath: (path: string) => string;
	/** file contents, or `undefined` when unreadable */
	readFile: (path: string) => string | undefined;
};

function readOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Where a source checkout's e2e driver lives; `/` (matches nothing) for builds without a checkout. */
export function importDirFor(build: BuildInfo): string {
	const sourceDir = build.channel === "release" ? undefined : build.sourceDir;
	return sourceDir ? join(sourceDir, "packages", "e2e", "src", "driver", "ios") : "/";
}

export function realHelperDeps(): HelperDeps {
	const build = currentBuild();
	return {
		platform: process.platform,
		arch: process.arch,
		execPath: process.execPath,
		importDir: importDirFor(build),
		version: build.version,
		exists: existsSync,
		realpath: realpathSync,
		readFile: readOrUndefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Build info of the helper at `helperPath`: `manifest.json` beside it, else the platform package.json `warden.helper`. */
export function helperInfo(deps: HelperDeps, helperPath: string): HelperInfo | undefined {
	const dir = dirname(helperPath);
	const manifest = deps.readFile(join(dir, HELPER_MANIFEST));
	if (manifest !== undefined) {
		const parsed = parseHelperManifest(manifest);
		if (parsed.success) return parsed.data;
	}
	const pkg = deps.readFile(join(dir, "..", "package.json"));
	const warden = pkg === undefined ? undefined : parseJson(pkg);
	const helper = isRecord(warden) && isRecord(warden.warden) ? warden.warden.helper : undefined;
	if (!isRecord(helper)) return undefined;
	const { version, idb, xcode } = helper;
	return typeof version === "string" && typeof idb === "string" && typeof xcode === "string"
		? { version, idb, xcode }
		: undefined;
}

async function firstBootedSim(ctx: CommandContext): Promise<string | undefined> {
	const result = await ctx.exec(["xcrun", "simctl", "list", "devices", "available", "-j"], { timeoutMs: 10_000 });
	if (result.exitCode !== 0) return undefined;
	const devices = parseSimctlDevices(result.stdout);
	return devices.success ? devices.data.find((device) => device.state === "booted")?.id : undefined;
}

/** Last JSON line of `warden-simd --health` stdout: a response (`{ok, data}`), a `fatal` event, or the bare data. */
function healthLine(stdout: string): Record<string, unknown> | undefined {
	for (const line of stdout.trim().split("\n").reverse()) {
		const parsed = parseJson(line);
		if (isRecord(parsed)) return parsed;
	}
	return undefined;
}

/** `data.<key>` as a record, if it is one. */
function child(parent: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	const value = parent?.[key];
	return isRecord(value) ? value : undefined;
}

/** Why a health probe gave no answer: the helper's own error, else stderr, else (timeout / crash) the exit code. */
function failureReason(line: Record<string, unknown> | undefined, stderr: string, exitCode: number): string {
	const message = child(line, "error")?.message;
	if (typeof message === "string") return message;
	return (
		stderr.trim().split("\n").pop() || `no answer within ${HEALTH_TIMEOUT_MS / 1000}s or crashed, exit ${exitCode}`
	);
}

function healthRow(
	stdout: string,
	exitCode: number,
	stderr: string,
	udid: string
): Pick<DoctorCheck, "status" | "detail"> {
	const line = healthLine(stdout);
	const data = child(line, "data") ?? line;
	const transport = child(data, "hid")?.transport;
	const ax = child(data, "ax");
	if (exitCode !== 0 || typeof transport !== "string" || typeof ax?.bridge !== "string") {
		return {
			status: "warn",
			detail: `warden-simd --health on ${udid} failed (${failureReason(line, stderr, exitCode)})`,
		};
	}
	const summary = `${udid}: hid.transport=${transport} ax.bridge=${ax.bridge}`;
	if (ax.bridge === "available") return { status: "ok", detail: summary };
	const reason = typeof ax.error === "string" ? ` (${ax.error})` : "";
	return { status: "warn", detail: `${summary}${reason} — snapshots fall back to the slower host-side AX` };
}

/**
 * The "simulator helper" doctor rows: where `warden-simd` was found and which build it is, and, with a booted
 * iOS simulator, whether it can drive it (`hid.transport` / `ax.bridge` from `warden-simd --health`).
 * Linux has no iOS, so it gets no rows; darwin-x64 is told there is no helper for it.
 */
export async function helperChecks(ctx: CommandContext, deps: HelperDeps): Promise<DoctorCheck[]> {
	const row = (name: string, status: DoctorCheck["status"], detail: string): DoctorCheck => ({
		name,
		level: "optional",
		status,
		detail,
	});
	const target = `${deps.platform}-${deps.arch}`;
	if (deps.platform !== "darwin") return [];
	if (target !== HELPER_TARGET) return [row("sim-helper", "ok", `no helper for ${target} in this version`)];

	const located = locateHelper({
		env: ctx.env,
		execPath: deps.execPath,
		importDir: deps.importDir,
		wardenHome: wardenHome(ctx.env),
		version: deps.version,
		exists: deps.exists,
		realpath: deps.realpath,
	});
	if (!located.success) {
		return [row("sim-helper", "warn", `${located.error.message} — or fetch it: \`warden doctor --fetch-helper\``)];
	}
	const { path, source } = located.data;
	const info = helperInfo(deps, path);
	const build = info ? ` — warden-simd ${info.version}, idb ${info.idb}, xcode ${info.xcode}` : "";
	const rows = [row("sim-helper", "ok", `${path} (${source})${build}`)];

	const udid = await firstBootedSim(ctx);
	if (!udid) return [...rows, row("sim-helper-health", "ok", "no booted iOS simulator to probe")];
	const health = await ctx.exec([path, "--health", "--udid", udid], { timeoutMs: HEALTH_TIMEOUT_MS });
	const { status, detail } = healthRow(health.stdout, health.exitCode, health.stderr, udid);
	return [...rows, row("sim-helper-health", status, detail)];
}
