import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { isLeaseAlive, processAlive } from "@warden/core/liveness";
import { androidTools } from "@warden/core/providers/android";
import { MIGRATIONS, wardenHome } from "@warden/core/store";
import type { Command, CommandContext } from "../context";
import { codexDetected } from "../hooks/agents";
import { hasWardenHook } from "../hooks/claude-settings";
import { codexConfigPath, codexHooksPath, codexTomlHasWardenHook } from "../hooks/codex-hooks";
import { errorMessage } from "../hooks/json";
import { emit } from "../output";

const USAGE = "warden doctor [--json]";

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

function onPath(ctx: CommandContext, home: string): Probe {
	const bin = join(home, ".local", "bin");
	const binary = join(bin, "warden");
	return attempt(() => {
		accessSync(binary, constants.X_OK);
		const dirs = (ctx.env.PATH ?? "").split(delimiter);
		return dirs.includes(bin)
			? { ok: true, detail: binary }
			: { ok: false, detail: `${bin} is not on PATH (hooks still work: they use $HOME/.local/bin/warden)` };
	});
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
		check("path", "optional", onPath(ctx, home)),
		check("claude-hook", "optional", claudeHook(home)),
		check("codex-hook", "optional", codexHook(ctx)),
		check("skill", "optional", skillPresent(home)),
		check("stale-leases", "optional", staleLeases(ctx)),
	];
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

async function run(ctx: CommandContext): Promise<number> {
	let json = false;
	try {
		const { values } = parseArgs({ args: ctx.argv, options: { json: { type: "boolean" } }, strict: true });
		json = values.json === true;
	} catch (error) {
		ctx.err(`warden doctor: ${errorMessage(error)}\n${USAGE}`);
		return 1;
	}
	const checks = await runChecks(ctx);
	const ok = checks.every((c) => c.status !== "fail");
	const width = Math.max(...checks.map((c) => c.name.length));
	const text = checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
	emit(ctx, json, { ok, checks }, text);
	return ok ? 0 : 1;
}

export const doctorCommand: Command = {
	name: "doctor",
	summary: "check warden's setup: home, db, device tools, PATH, Claude/Codex hooks + skill, stale leases",
	usage: USAGE,
	run,
};
