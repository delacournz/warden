import { DEFAULT_TTL_MS } from "@warden/core/config.defaults";
import { isLeaseAlive, type PidAlive } from "@warden/core/liveness";
import type { GitInfo } from "@warden/core/owner";
import type { Store } from "@warden/core/store";
import {
	type AgentOwner,
	type DeviceResource,
	describeOwner,
	type Lease,
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
	/** current state of a device (undefined = unknown); decides whether the session is the one booting it */
	deviceState: (platform: Platform, id: string) => Promise<"booted" | "shutdown" | undefined>;
	/** shut down what the shutdown policy allows for these ending leases */
	shutdown: (leases: Lease[], owner: Owner) => Promise<{ shutdown: string[]; notes: string[] }>;
	/** kick off a background `warden gc` if one hasn't run recently (never throws, never waits) */
	maybeGc: () => void;
	/**
	 * Start a detached worker that shuts down + releases this session's devices; true if started.
	 * SessionEnd hooks are time-capped (Codex: ~3 s) and a sim shutdown can take longer.
	 */
	endInBackground: (sessionId: string) => boolean;
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

/** Device off right now? Then this session is about to boot it (e.g. argent boot-device) — it owns shutting it down. */
async function sessionWillBoot(deps: HookDeps, platform: Platform, id: string): Promise<boolean> {
	try {
		return (await deps.deviceState(platform, id)) === "shutdown";
	} catch {
		return false;
	}
}

function nudgeGc(deps: HookDeps): void {
	try {
		deps.maybeGc();
	} catch {
		// best effort — gc also runs on claims and on demand
	}
}

/**
 * PreToolUse for argent device tools. Unleased device → lease it to this Claude session (noting
 * whether the session is the one booting it); own lease → heartbeat; stale lease → reclaim; another
 * live owner → block (exit 2). Never blocks on warden's own failures — a broken warden must not
 * break the agent.
 */
export async function handlePreToolUse(raw: unknown, deps: HookDeps): Promise<HookResult> {
	try {
		const input = parsePreTool(raw);
		if (!input || !ARGENT_TOOL.test(input.toolName) || input.deviceId === undefined) return { exitCode: 0 };
		const target = deviceTarget(input.deviceId);
		if (target.kind === "skip") return { exitCode: 0 };
		nudgeGc(deps);

		const me: AgentOwner = { kind: "agent", sessionId: input.sessionId, cwd: input.cwd };
		const store = deps.store();
		const probe: DeviceResource = { kind: "device", platform: target.platform, id: target.id, name: target.id };
		const current = store.findLeaseByResource(probe);
		const claiming = !current || (!sameOwner(current.owner, me) && !isLeaseAlive(current, deps.now(), deps.pidAlive));
		const bootedByOwner = claiming ? await sessionWillBoot(deps, target.platform, target.id) : false;
		const now = deps.now();
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
					...(bootedByOwner ? { bootedByOwner: true } : {}),
				},
				now
			);
			return { exitCode: 0 };
		});
	} catch (error) {
		return { exitCode: 0, stderr: `warden hook pretool: ${errorMessage(error)} (allowing)` };
	}
}

function startWorker(deps: HookDeps, sessionId: string): boolean {
	try {
		return deps.endInBackground(sessionId);
	} catch {
		return false;
	}
}

/**
 * SessionEnd: shut down the session's devices the shutdown policy allows (warden-created, or booted
 * by this session) so nothing is left running, then release every lease the session holds. On
 * `/clear` (reason `clear`) devices stay up — the conversation restarts but the work usually goes on
 * with the same sim, which the new session re-claims on its next argent call. When there are devices
 * to shut down the work goes to a detached worker (`warden release --session S --shutdown`, which
 * shuts down before releasing) so the hook returns inside the agent's time cap; inline otherwise.
 */
export async function handleSessionEnd(raw: unknown, deps: HookDeps): Promise<HookResult> {
	try {
		const sessionId = isRecord(raw) ? stringField(raw, "session_id") : undefined;
		if (!sessionId || !isRecord(raw)) return { exitCode: 0 };
		const owner: AgentOwner = { kind: "agent", sessionId, cwd: "" };
		const store = deps.store();
		const leases = store.listLeasesByOwner(owner);
		const lines: string[] = [];
		const keepRunning = stringField(raw, "reason") === "clear";
		const hasDevices = leases.some((l) => l.resource.kind === "device");
		if (!keepRunning && hasDevices && startWorker(deps, sessionId)) {
			return {
				exitCode: 0,
				stdout: `warden: shutting down + releasing session ${sessionId} devices in the background`,
			};
		}
		if (!keepRunning) {
			try {
				const devices = leases.filter((l) => l.resource.kind === "device");
				const outcome = devices.length > 0 ? await deps.shutdown(devices, owner) : { shutdown: [], notes: [] };
				if (outcome.shutdown.length > 0) lines.push(`warden: shut down ${outcome.shutdown.join(" ")}`);
				lines.push(...outcome.notes.map((n) => `warden: ${n}`));
			} catch (error) {
				lines.push(`warden: shutdown failed (${errorMessage(error)}) — releasing anyway`);
			}
		}
		const now = deps.now();
		store.transaction(() => {
			store.deleteLeases(leases.map((l) => l.id));
			for (const l of leases) {
				if (l.resource.kind === "device") store.touchDevice(l.resource.platform, l.resource.id, now);
			}
		});
		if (leases.length > 0) lines.unshift(`warden: released ${leases.map((l) => l.id).join(" ")}`);
		return lines.length > 0 ? { exitCode: 0, stdout: lines.join("\n") } : { exitCode: 0 };
	} catch (error) {
		return { exitCode: 0, stderr: `warden hook session-end: ${errorMessage(error)}` };
	}
}
