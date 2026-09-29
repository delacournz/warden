import { DEFAULT_TTL_MS } from "@warden/core/config.defaults";
import { isLeaseAlive, type PidAlive } from "@warden/core/liveness";
import type { GitInfo } from "@warden/core/owner";
import type { Store } from "@warden/core/store";
import {
	type AgentOwner,
	type DeviceResource,
	describeOwner,
	type Owner,
	ownerLocation,
	type Platform,
	sameOwner,
} from "@warden/core/types";
import { errorMessage, isRecord, stringField } from "./json";

/** Claude Code hook outcome: exit 0 = allow, 2 = block (stderr is shown to the model). */
export type HookResult = { exitCode: 0 | 2; stderr?: string; stdout?: string };

export type HookDeps = {
	store: () => Store;
	now: () => number;
	pidAlive: PidAlive;
	gitInfo: (cwd: string) => GitInfo | undefined;
};

/** PreToolUse matcher for argent's device tools (plain + plugin-namespaced MCP servers). */
export const ARGENT_MATCHER = "mcp__argent__.*|mcp__plugin_goldie_argent__.*";
const ARGENT_TOOL = /^(mcp__argent__|mcp__plugin_goldie_argent__)/;

export const HOOK_LABEL = "claude-hook";

const SIM_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_UDID = /^[0-9a-f]{8}-[0-9a-f]{16}$/i;

export type DeviceTarget = { kind: "device"; platform: Platform; id: string } | { kind: "skip" };

/** iOS = UDID shape; `chromium-cdp-*` is not a device warden leases; anything else = adb serial. */
export function deviceTarget(id: string): DeviceTarget {
	if (id.length === 0 || id.startsWith("chromium-cdp-")) return { kind: "skip" };
	if (SIM_UDID.test(id) || PHONE_UDID.test(id)) return { kind: "device", platform: "ios", id };
	return { kind: "device", platform: "android", id };
}

type PreToolInput = { sessionId: string; cwd: string; toolName: string; deviceId?: string };

function parsePreTool(raw: unknown): PreToolInput | undefined {
	if (!isRecord(raw)) return undefined;
	const sessionId = stringField(raw, "session_id");
	const toolName = stringField(raw, "tool_name");
	if (!sessionId || !toolName) return undefined;
	const toolInput = isRecord(raw.tool_input) ? raw.tool_input : {};
	const deviceId =
		stringField(toolInput, "udid") ?? stringField(toolInput, "device_id") ?? stringField(toolInput, "serial");
	const parsed: PreToolInput = { sessionId, cwd: stringField(raw, "cwd") ?? "", toolName };
	if (deviceId !== undefined) parsed.deviceId = deviceId;
	return parsed;
}

function blockMessage(id: string, platform: Platform, owner: Owner): string {
	const where = ownerLocation(owner);
	const noun = platform === "ios" ? "udid" : "serial";
	return `device ${id} leased by ${describeOwner(owner)}${where ? ` (${where})` : ""} — run \`warden claim ${platform}\` and use the returned ${noun}`;
}

/** git lookup must never cost the lease (e.g. cwd deleted under the session). */
function safeGitInfo(cwd: string, deps: HookDeps): GitInfo | undefined {
	try {
		return deps.gitInfo(cwd);
	} catch {
		return undefined;
	}
}

function agentOwner(input: PreToolInput, deps: HookDeps): AgentOwner {
	const owner: AgentOwner = { kind: "agent", sessionId: input.sessionId, cwd: input.cwd };
	const git = input.cwd ? safeGitInfo(input.cwd, deps) : undefined;
	if (git) {
		owner.repo = git.repo;
		owner.worktree = git.worktree;
	}
	return owner;
}

/**
 * PreToolUse for argent device tools. Unleased device → lease it to this Claude session; own lease →
 * heartbeat; stale lease → reclaim; another live owner → block (exit 2). Never blocks on warden's own
 * failures — a broken warden must not break the agent.
 */
export function handlePreToolUse(raw: unknown, deps: HookDeps): HookResult {
	try {
		const input = parsePreTool(raw);
		if (!input || !ARGENT_TOOL.test(input.toolName) || input.deviceId === undefined) return { exitCode: 0 };
		const target = deviceTarget(input.deviceId);
		if (target.kind === "skip") return { exitCode: 0 };

		const me: AgentOwner = { kind: "agent", sessionId: input.sessionId, cwd: input.cwd };
		const store = deps.store();
		const now = deps.now();
		const probe: DeviceResource = { kind: "device", platform: target.platform, id: target.id, name: target.id };
		return store.transaction((): HookResult => {
			const existing = store.findLeaseByResource(probe);
			if (existing && sameOwner(existing.owner, me)) {
				store.heartbeat([existing.id], now);
				return { exitCode: 0 };
			}
			if (existing && isLeaseAlive(existing, now, deps.pidAlive)) {
				return { exitCode: 2, stderr: blockMessage(target.id, target.platform, existing.owner) };
			}
			if (existing) store.deleteLeases([existing.id]);
			const known = store.listDevices(target.platform).find((d) => d.id === target.id);
			store.insertLease(
				{
					resource: { ...probe, name: known?.name ?? target.id },
					owner: agentOwner(input, deps),
					ttlMs: DEFAULT_TTL_MS,
					label: HOOK_LABEL,
				},
				now
			);
			return { exitCode: 0 };
		});
	} catch (error) {
		return { exitCode: 0, stderr: `warden hook pretool: ${errorMessage(error)} (allowing)` };
	}
}

/** SessionEnd: release every lease this Claude session holds (devices are left running). */
export function handleSessionEnd(raw: unknown, deps: HookDeps): HookResult {
	try {
		const sessionId = isRecord(raw) ? stringField(raw, "session_id") : undefined;
		if (!sessionId) return { exitCode: 0 };
		const store = deps.store();
		const now = deps.now();
		const released = store.transaction(() => {
			const leases = store.listLeasesByOwner({ kind: "agent", sessionId, cwd: "" });
			store.deleteLeases(leases.map((l) => l.id));
			for (const l of leases) {
				if (l.resource.kind === "device") store.touchDevice(l.resource.platform, l.resource.id, now);
			}
			return leases.map((l) => l.id);
		});
		return released.length > 0 ? { exitCode: 0, stdout: `warden: released ${released.join(" ")}` } : { exitCode: 0 };
	} catch (error) {
		return { exitCode: 0, stderr: `warden hook session-end: ${errorMessage(error)}` };
	}
}

export type SessionStartDeps = { envFile?: string; appendFile: (path: string, text: string) => void };

const SAFE_SESSION = /^[A-Za-z0-9._-]+$/;

/**
 * SessionStart: export `WARDEN_SESSION_ID` via `$CLAUDE_ENV_FILE` so `warden claim` run from the
 * agent's Bash tool owns leases as this session — the same owner the PreToolUse hook sees.
 */
export function handleSessionStart(raw: unknown, deps: SessionStartDeps): HookResult {
	try {
		const sessionId = isRecord(raw) ? stringField(raw, "session_id") : undefined;
		if (!sessionId || !deps.envFile || !SAFE_SESSION.test(sessionId)) return { exitCode: 0 };
		deps.appendFile(deps.envFile, `export WARDEN_SESSION_ID='${sessionId}'\n`);
		return { exitCode: 0 };
	} catch (error) {
		return { exitCode: 0, stderr: `warden hook session-start: ${errorMessage(error)}` };
	}
}
