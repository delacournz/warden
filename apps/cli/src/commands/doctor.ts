import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { androidTools } from "@delacour/warden-core/providers/android";
import { MIGRATIONS, wardenHome } from "@delacour/warden-core/store";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { codexDetected } from "../hooks/agents";
import { hasWardenHook } from "../hooks/claude-settings";
import { codexConfigPath, codexHooksPath, codexTomlHasWardenHook } from "../hooks/codex-hooks";
import { errorMessage } from "../hooks/json";
import { NPM_PACKAGE } from "../npm/platforms";
import { emit } from "../output";
import { type BuildInfo, currentBuild } from "../update/build-info";
import { type InstallOrigin, installOrigin } from "../update/install-origin";
import { describePackageInstall, detectPackageInstall, upgradeCommand } from "../update/package-install";

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
		const missing = (["pretool", "session-end"] as const).filter((name) => !hasWardenHook(settings, name));
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
		const missing = (["pretool", "session-end"] as const).filter(
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

export async function runChecks(ctx: CommandContext): Promise<DoctorCheck[]> {
	const home = ctx.env.HOME ?? "";
	const { adb, emulator } = androidTools(ctx.env);
	const [simctl, adbProbe, emulatorProbe] = await Promise.all([
		tool(ctx, ["xcrun", "simctl", "help"], "xcrun simctl not available (install Xcode) — iOS disabled"),
		tool(ctx, [adb, "version"], `${adb} not found (set ANDROID_HOME) — Android disabled`),
		tool(ctx, [emulator, "-version"], `${emulator} not found (set ANDROID_HOME) — Android disabled`),
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

async function doctor(ctx: CommandContext, json: boolean): Promise<number> {
	const { color } = ctx.ui;
	const checks = await runChecks(ctx);
	const ok = checks.every((c) => c.status !== "fail");
	const width = Math.max(...checks.map((c) => c.name.length));
	const text = checks
		.map((c) => {
			const detail = c.status === "ok" ? color.dim(c.detail) : c.detail;
			return `${mark(ctx, c.status)} ${c.name.padEnd(width)}  ${detail}`;
		})
		.join("\n");
	emit(ctx, json, { ok, checks }, text);
	return ok ? 0 : 1;
}

export const doctorCommand = defineCommand({
	name: "doctor",
	summary:
		"check warden's setup: home, db, device tools, install method, PATH, Claude/Codex hooks + skill, stale leases",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action(async (opts) => done(await doctor(ctx, opts.json === true)));
	},
});
