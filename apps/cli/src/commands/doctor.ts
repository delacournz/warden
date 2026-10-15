import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { androidTools } from "@delacour/warden-core/providers/android";
import { MIGRATIONS, wardenHome } from "@delacour/warden-core/store";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { codexDetected } from "../hooks/agents";
import { hasWardenHook } from "../hooks/claude-settings";
import { codexConfigPath, codexHooksPath, codexTomlHasWardenHook } from "../hooks/codex-hooks";
import { errorMessage } from "../hooks/json";
import { NPM_PACKAGE } from "../npm/platforms";
import { emit } from "../output";
import { type BuildInfo, currentBuild } from "../update/build-info";
import { fetchHelper, tarExtractHelper } from "../update/fetch-helper";
import { type InstallOrigin, installOrigin } from "../update/install-origin";
import type { Fetch } from "../update/npm-registry";
import { describePackageInstall, detectPackageInstall, upgradeCommand } from "../update/package-install";
import { type HelperDeps, helperChecks, realHelperDeps } from "./doctor-helper";

export type CheckStatus = "ok" | "warn" | "fail";
/** core failures make doctor exit 1; optional ones only warn */
export type CheckLevel = "core" | "optional";
export type DoctorCheck = { name: string; level: CheckLevel; status: CheckStatus; detail: string };

type Probe = { ok: true; detail: string } | { ok: false; detail: string };

function check(name: string, level: CheckLevel, probe: Probe): DoctorCheck {
	const status: CheckStatus = probe.ok ? "ok" : level === "core" ? "fail" : "warn";
	return { name, level, status, detail: probe.detail };
}

function attempt(fn: () => Probe): Probe {
	try {
		return fn();
	} catch (error) {
		return { ok: false, detail: errorMessage(error) };
	}
}

function homeWritable(dir: string): Probe {
	return attempt(() => {
		mkdirSync(dir, { recursive: true });
		const probe = join(dir, `.doctor-${process.pid}`);
		writeFileSync(probe, "");
		rmSync(probe);
		return { ok: true, detail: dir };
	});
}

function dbSchema(ctx: CommandContext): Probe {
	return attempt(() => {
		const row = ctx.store().db.query<{ user_version: number }, []>("PRAGMA user_version").get();
		const version = row?.user_version ?? 0;
		if (version > MIGRATIONS.length) {
			return { ok: false, detail: `schema v${version} is newer than this warden (v${MIGRATIONS.length}) — upgrade` };
		}
		return { ok: true, detail: `schema v${version}` };
	});
}

async function tool(ctx: CommandContext, cmd: string[], missing: string): Promise<Probe> {
	try {
		const result = await ctx.exec(cmd, { timeoutMs: 10_000 });
		if (result.exitCode !== 0) return { ok: false, detail: missing };
		const first = result.stdout.trim().split("\n")[0] ?? "";
		return { ok: true, detail: first || cmd.join(" ") };
	} catch {
		return { ok: false, detail: missing };
	}
}

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Hooks run `$HOME/.local/bin/warden`; the shell may find `warden` there or elsewhere (e.g. an npm global bin). */
function onPath(ctx: CommandContext, home: string): Probe {
	const bin = join(home, ".local", "bin");
	const binary = join(bin, "warden");
	if (!executable(binary)) return { ok: false, detail: `${binary} missing — run \`warden install\` (hooks call it)` };
	return attempt(() => {
		const dirs = (ctx.env.PATH ?? "").split(delimiter).filter(Boolean);
		if (dirs.includes(bin)) return { ok: true, detail: binary };
		const other = dirs.map((dir) => join(dir, "warden")).find(executable);
		return other
			? { ok: true, detail: `${binary} (hooks); \`warden\` on PATH → ${other}` }
			: { ok: false, detail: `${bin} is not on PATH (hooks still work: they use $HOME/.local/bin/warden)` };
	});
}

/** How this warden was installed and how it upgrades. Informational: always ok. */
export function installProbe(build: BuildInfo, execPath: string, origin?: InstallOrigin): Probe {
	if (build.channel === "dev") {
		return {
			ok: true,
			detail: `running from source ${build.sourceDir} — \`warden update\` builds ~/.local/bin/warden`,
		};
	}
	const managed = detectPackageInstall(execPath);
	if (managed) return { ok: true, detail: `${describePackageInstall(managed)} — upgrade: ${upgradeCommand(managed)}` };
	if (origin === "npm") {
		return {
			ok: true,
			detail: `${build.channel} binary ${execPath} (from npm) — \`warden update\` upgrades it from ${NPM_PACKAGE} on npm`,
		};
	}
	return { ok: true, detail: `${build.channel} binary ${execPath} — \`warden update\` upgrades it` };
}

function claudeHook(home: string): Probe {
	const path = join(home, ".claude", "settings.json");
	return attempt(() => {
		const settings: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
		const missing = (["session-end"] as const).filter((name) => !hasWardenHook(settings, name));
		return missing.length === 0
			? { ok: true, detail: path }
			: { ok: false, detail: `missing warden hook ${missing.join(", ")} — run \`warden install --claude\`` };
	});
}

/** Codex: optional — only checked when Codex is detected; hooks may live in hooks.json or config.toml. */
function codexHook(ctx: CommandContext): Probe {
	if (!codexDetected(ctx.env)) return { ok: true, detail: "codex not detected" };
	const path = codexHooksPath(ctx.env);
	const configPath = codexConfigPath(ctx.env);
	if (!path || !configPath) return { ok: false, detail: "$HOME / $CODEX_HOME not set" };
	return attempt(() => {
		const hooks: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
		const toml = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
		const missing = (["session-end"] as const).filter(
			(name) => !hasWardenHook(hooks, name) && !codexTomlHasWardenHook(toml, name)
		);
		return missing.length === 0
			? { ok: true, detail: path }
			: { ok: false, detail: `missing warden hook ${missing.join(", ")} — run \`warden install --codex\`` };
	});
}

function skillPresent(home: string): Probe {
	const path = join(home, ".claude", "skills", "warden", "SKILL.md");
	return existsSync(path) ? { ok: true, detail: path } : { ok: false, detail: "run `warden install --claude`" };
}

function staleLeases(ctx: CommandContext): Probe {
	return attempt(() => {
		const now = ctx.now();
		const leases = ctx.store().listLeases();
		const stale = leases.filter((l) => !isLeaseAlive(l, now, processAlive)).length;
		if (stale === 0) return { ok: true, detail: `${leases.length} active` };
		return { ok: false, detail: `${stale} stale lease${stale === 1 ? "" : "s"} — run \`warden gc\`` };
	});
}

/**
 * Expo iOS project in the cwd: native builds are only worth caching with ccache enabled in the Podfile
 * properties, and React Native built from source defeats it. Not an Expo iOS project → ok.
 */
export function ccacheProject(cwd: string): Probe {
	const path = join(cwd, "ios", "Podfile.properties.json");
	if (!existsSync(path)) return { ok: true, detail: "no ios/Podfile.properties.json here" };
	return attempt(() => {
		const props: unknown = JSON.parse(readFileSync(path, "utf8"));
		const get = (key: string): unknown =>
			typeof props === "object" && props !== null ? Reflect.get(props, key) : undefined;
		const problems: string[] = [];
		if (get("apple.ccacheEnabled") !== "true") {
			problems.push('"apple.ccacheEnabled" is not "true" — set expo-build-properties `ios.ccacheEnabled: true`');
		}
		if (get("ios.buildReactNativeFromSource") === "true") {
			problems.push('"ios.buildReactNativeFromSource" is "true" — rebuilds React Native every cache miss');
		}
		return problems.length === 0 ? { ok: true, detail: path } : { ok: false, detail: problems.join("; ") };
	});
}

export async function runChecks(ctx: CommandContext, helper: HelperDeps = realHelperDeps()): Promise<DoctorCheck[]> {
	const home = ctx.env.HOME ?? "";
	const { adb, emulator } = androidTools(ctx.env);
	const [simctl, adbProbe, emulatorProbe, ccache, simHelper] = await Promise.all([
		tool(ctx, ["xcrun", "simctl", "help"], "xcrun simctl not available (install Xcode) — iOS disabled"),
		tool(ctx, [adb, "version"], `${adb} not found (set ANDROID_HOME) — Android disabled`),
		tool(ctx, [emulator, "-version"], `${emulator} not found (set ANDROID_HOME) — Android disabled`),
		tool(
			ctx,
			["ccache", "--version"],
			"ccache not on PATH — `brew install ccache` to speed up native iOS cache-miss builds"
		),
		helperChecks(ctx, helper),
	]);
	return [
		check("home", "core", homeWritable(wardenHome(ctx.env))),
		check("db", "core", dbSchema(ctx)),
		check("simctl", "optional", simctl),
		check("adb", "optional", adbProbe),
		check("emulator", "optional", emulatorProbe),
		check(
			"install",
			"optional",
			installProbe(currentBuild(), process.execPath, installOrigin(ctx.env, process.execPath))
		),
		check("ccache", "optional", ccache),
		check("ccache-project", "optional", ccacheProject(ctx.cwd)),
		...simHelper,
		check("path", "optional", onPath(ctx, home)),
		check("claude-hook", "optional", claudeHook(home)),
		check("codex-hook", "optional", codexHook(ctx)),
		check("skill", "optional", skillPresent(home)),
		check("stale-leases", "optional", staleLeases(ctx)),
	];
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

function mark(ctx: CommandContext, status: CheckStatus): string {
	const { color } = ctx.ui;
	switch (status) {
		case "ok":
			return color.green(MARK.ok);
		case "warn":
			return color.yellow(MARK.warn);
		case "fail":
			return color.red(MARK.fail);
	}
}

/** Outside world for `warden doctor`, injectable for tests. */
export type DoctorDeps = {
	helper: HelperDeps;
	/** `--fetch-helper` downloads from GitHub releases (or `WARDEN_HELPER_URL`) */
	fetch: Fetch;
};

type FetchedHelperReport = { dir: string; url: string; sha256: string };

async function doctor(
	ctx: CommandContext,
	deps: DoctorDeps,
	opts: { json: boolean; fetchHelper: boolean }
): Promise<number> {
	const { color } = ctx.ui;
	let fetched: FetchedHelperReport | undefined;
	if (opts.fetchHelper) {
		const result = await fetchHelper({
			fetch: deps.fetch,
			extract: tarExtractHelper(ctx.exec),
			env: ctx.env,
			platform: deps.helper.platform,
			arch: deps.helper.arch,
			version: deps.helper.version,
			wardenHome: wardenHome(ctx.env),
		});
		if (!result.success) {
			ctx.err(color.red(`warden doctor: --fetch-helper: ${result.error}`));
			return 1;
		}
		fetched = result.data;
		if (!opts.json) ctx.out(`fetched warden-simd → ${fetched.dir} (${fetched.url})`);
	}
	const checks = await runChecks(ctx, deps.helper);
	const ok = checks.every((c) => c.status !== "fail");
	const width = Math.max(...checks.map((c) => c.name.length));
	const text = checks
		.map((c) => {
			const detail = c.status === "ok" ? color.dim(c.detail) : c.detail;
			return `${mark(ctx, c.status)} ${c.name.padEnd(width)}  ${detail}`;
		})
		.join("\n");
	emit(ctx, opts.json, { ok, checks, ...(fetched ? { helperFetch: fetched } : {}) }, text);
	return ok ? 0 : 1;
}

export function createDoctorCommand(deps: DoctorDeps): Command {
	return defineCommand({
		name: "doctor",
		summary:
			"check warden's setup: home, db, device tools, simulator helper, install method, PATH, Claude/Codex hooks + skill, stale leases",
		register: (cmd, ctx, done) => {
			cmd
				.option("--fetch-helper", "download warden-simd for this version into $WARDEN_HOME/simd/<version>/ first")
				.option("--json", "machine-readable output")
				.action(async (opts) =>
					done(await doctor(ctx, deps, { json: opts.json === true, fetchHelper: opts.fetchHelper === true }))
				);
		},
	});
}

export const doctorCommand: Command = createDoctorCommand({ helper: realHelperDeps(), fetch: (url) => fetch(url) });
