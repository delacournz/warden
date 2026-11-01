import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_MARGIN_MS, type RunnerMeta, runnerCache } from "@delacour/warden-builds/ios-runner/cache";
import { signing } from "@delacour/warden-builds/ios-runner/signing";
import { runnerStage } from "@delacour/warden-builds/ios-runner/stage";
import { hostDeps } from "@delacour/warden-core/host-deps";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { Devicectl } from "@delacour/warden-providers/devicectl";
import { timers } from "@delacour/warden-providers/health";
import { storeLocator } from "@delacour/warden-store/store";
import { type InventoryDevice, leaseModel } from "@delacour/warden-store/types";
import { type CommandContext, contextBuilder } from "../context";
import type { CheckStatus, DoctorCheck } from "./doctor";

/**
 * Optional doctor rows for real phones and tablets (`ios-team`, `ios-devices`, `ios-runner`, `android-devices`).
 * A row appears only when it has something to say: no phone and no signing team means no rows at all. Read-only:
 * `devicectl list` / `lockState`, `adb devices`, `security find-identity` and `ps`. Never a `fail`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const row = (name: string, status: CheckStatus, detail: string): DoctorCheck => ({
	name,
	level: "optional",
	status,
	detail,
});

type IosFacts = Extract<NonNullable<InventoryDevice["physical"]>, { platform: "ios" }>;

function iosFacts(d: InventoryDevice): IosFacts | undefined {
	return d.physical?.platform === "ios" ? d.physical : undefined;
}

function isReady(d: InventoryDevice): boolean {
	return d.state === "booted" && leaseModel.physicalNotReadyReason(d) === undefined;
}

async function describeIos(ctx: CommandContext, d: InventoryDevice, facts: IosFacts): Promise<string> {
	const parts = [
		facts.transport,
		facts.pairingState === undefined ? "paired" : `unpaired (${facts.pairingState})`,
		facts.developerMode ? "Developer Mode on" : "Developer Mode off",
		facts.ddi ? "DDI yes" : "DDI no",
	];
	if (facts.unreachable !== undefined) parts.push(`offline (${facts.unreachable})`);
	else if (isReady(d) && facts.locked !== undefined) parts.push(`reachable, ${facts.locked ? "locked" : "unlocked"}`);
	else if (isReady(d)) {
		const lock = await new Devicectl({ exec: ctx.exec, timer: timers.real }).readLockState(d.id);
		parts.push(lock.success ? `reachable, ${lock.data.locked ? "locked" : "unlocked"}` : "reachable");
	}
	return `${d.id} ${facts.deviceType} ${facts.osVersion}: ${parts.join(", ")}`;
}

function configTeamId(ctx: CommandContext, find: typeof import("@delacour/warden-builds/config").projectConfig.find) {
	const found = find(ctx.cwd, undefined, ctx.env);
	return found.success ? found.data?.config.ios?.teamId : undefined;
}

async function teamRow(ctx: CommandContext, hasPhones: boolean): Promise<{ row?: DoctorCheck; team?: string }> {
	const { projectConfig } = await import("@delacour/warden-builds/config");
	const resolved = await signing.resolveTeam({
		env: ctx.env,
		exec: ctx.exec,
		configTeamId: configTeamId(ctx, (...a) => projectConfig.find(...a)),
	});
	if (resolved.success) {
		const { team, source } = resolved.data;
		const from = source === "env" ? "WARDEN_IOS_TEAM_ID" : source === "config" ? "ios.teamId" : "keychain";
		return { row: row("ios-team", "ok", `${team} (${from})`), team };
	}
	const { error } = resolved;
	if (error.code === "ios_team_ambiguous") {
		return { row: row("ios-team", "warn", `ambiguous: ${error.teams.length} teams, set WARDEN_IOS_TEAM_ID`) };
	}
	return hasPhones ? { row: row("ios-team", "warn", `${error.message}. ${error.hint}`) } : {};
}

type CachedBuild = { dir: string; meta: RunnerMeta };

/** The newest cached runner build for `team` (any team when unresolved) (`<home>/ios-runner/<team>/<xcode>-<hash>/meta.json`). */
function newestBuild(home: string, team: string | undefined): CachedBuild | undefined {
	const root = runnerStage.root(home);
	if (!existsSync(root)) return undefined;
	const teamDirs = team === undefined ? readdirSync(root).map((name) => join(root, name)) : [join(root, team)];
	const builds = teamDirs.flatMap((teamDir) => {
		if (!existsSync(teamDir) || !statSync(teamDir).isDirectory()) return [];
		return readdirSync(teamDir).flatMap((name) => {
			const dir = join(teamDir, name);
			const meta = runnerCache.readMeta(dir);
			return meta === undefined ? [] : [{ dir, meta }];
		});
	});
	return builds.sort((a, b) => b.meta.builtAt - a.meta.builtAt)[0];
}

function describeExpiry(expires: number | null, now: number): { text: string; warn: boolean } {
	if (expires === null) return { text: "profile expiry unknown", warn: false };
	const left = expires - now;
	if (left <= 0) return { text: "profile expired (rebuilds on next use)", warn: true };
	const text = left >= DAY_MS ? `${Math.floor(left / DAY_MS)}d` : `${Math.max(1, Math.floor(left / 3_600_000))}h`;
	return { text: `profile expires in ${text}`, warn: left < PROFILE_MARGIN_MS };
}

/** The last runner failure the host recorded for a phone (`$WARDEN_HOME/ios-runner/<udid>.json`), if any. */
function lastFailure(home: string, udid: string): string | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(runnerStage.root(home), `${udid}.json`), "utf8"));
		if (typeof raw !== "object" || raw === null) return undefined;
		const { code, message } = raw as Record<string, unknown>;
		const text = [typeof code === "string" ? code : undefined, typeof message === "string" ? message : undefined];
		const joined = text.filter((t) => t !== undefined).join(": ");
		return joined === "" ? undefined : joined;
	} catch {
		return undefined;
	}
}

function runnerRow(ctx: CommandContext, team: string | undefined, phones: InventoryDevice[]): DoctorCheck | undefined {
	const home = storeLocator.wardenHome(ctx.env);
	const failures = phones.flatMap((d) => {
		const failure = lastFailure(home, d.id);
		return failure === undefined ? [] : [`last failure: ${failure} (${d.id})`];
	});
	const build = newestBuild(home, team);
	if (phones.length === 0 && build === undefined && failures.length === 0) return undefined;
	const parts: string[] = [];
	let warn = failures.length > 0;
	if (build === undefined) parts.push("no cached build (the first `warden ui` on a phone builds it)");
	else {
		const expiry = describeExpiry(build.meta.profileExpires, ctx.now());
		warn = warn || expiry.warn;
		parts.push(`cached build ${build.dir}`, expiry.text);
	}
	return row("ios-runner", warn ? "warn" : "ok", [...parts, ...failures].join("; "));
}

async function iosRows(ctx: CommandContext): Promise<DoctorCheck[]> {
	const listed = await new Devicectl({ exec: ctx.exec, timer: timers.real }).listPhysical();
	const phones = listed.success ? listed.data : [];
	const team = await teamRow(ctx, phones.length > 0);
	const rows: DoctorCheck[] = team.row ? [team.row] : [];
	if (phones.length > 0) {
		const lines = await Promise.all(
			phones.flatMap((d) => {
				const facts = iosFacts(d);
				return facts === undefined ? [] : [describeIos(ctx, d, facts)];
			})
		);
		rows.push(row("ios-devices", phones.some(isReady) ? "ok" : "warn", lines.join(" | ")));
	}
	const runner = runnerRow(ctx, team.team, phones);
	if (runner) rows.push(runner);
	return rows;
}

/** pids of `adb ... fork-server` processes: two means two adb servers fighting over the same phones. */
async function adbServerCount(ctx: CommandContext): Promise<number> {
	const ps = await ctx.exec(["ps", "-axo", "pid=,command="], { timeoutMs: 5_000 }).catch(() => undefined);
	if (ps === undefined || ps.exitCode !== 0) return 0;
	return ps.stdout.split("\n").filter((line) => /\badb\b.*\bfork-server\b/.test(line)).length;
}

async function androidRows(ctx: CommandContext): Promise<DoctorCheck[]> {
	const [inventory, servers] = await Promise.all([
		hostDeps.providerFor("android", contextBuilder.appHostFromContext(ctx), ownerResolver.resolve(ctx)).inventory(),
		adbServerCount(ctx),
	]);
	const phones = (inventory.success ? inventory.data : []).filter((d) => d.physical?.platform === "android");
	if (phones.length === 0 && servers <= 1) return [];
	const unauthorized = phones.filter(
		(d) => d.physical?.platform === "android" && d.physical.adbState === "unauthorized"
	);
	const offline = phones.filter((d) => d.physical?.platform === "android" && d.physical.adbState === "offline");
	const parts = [`${phones.length} phone${phones.length === 1 ? "" : "s"}`];
	if (unauthorized.length > 0)
		parts[0] = `${parts[0]}, ${unauthorized.length} unauthorized (accept the USB debugging prompt)`;
	if (offline.length > 0) parts.push(`${offline.length} offline (reconnect the cable)`);
	if (servers > 1) parts.push(`${servers} adb servers running (adb kill-server, keep one)`);
	return [
		row("android-devices", unauthorized.length + offline.length > 0 || servers > 1 ? "warn" : "ok", parts.join("; ")),
	];
}

export async function physicalChecks(ctx: CommandContext): Promise<DoctorCheck[]> {
	const [ios, android] = await Promise.all([iosRows(ctx), androidRows(ctx)]);
	return [...ios, ...android];
}
