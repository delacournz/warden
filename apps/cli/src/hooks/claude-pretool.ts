import type { PidAlive } from "@delacour/warden-core/liveness";
import type { Store } from "@delacour/warden-core/store";
import type { AgentOwner, Lease, Owner, Platform } from "@delacour/warden-core/types";
import { releaseDevices } from "../device-lease";
import { errorMessage, isRecord, stringField } from "./json";

/** Claude Code hook outcome: exit 0 = allow, 2 = block (stderr is shown to the model). */
export type HookResult = { exitCode: 0 | 2; stderr?: string; stdout?: string };

export type HookDeps = {
	store: () => Store;
	now: () => number;
	pidAlive: PidAlive;
	/** shut down what the shutdown policy allows for these ending leases */
	shutdown: (leases: Lease[], owner: Owner) => Promise<{ shutdown: string[]; notes: string[] }>;
	/**
	 * Start a detached worker that shuts down + releases this session's devices; true if started.
	 * SessionEnd hooks are time-capped (Codex: ~3 s) and a sim shutdown can take longer.
	 */
	endInBackground: (sessionId: string) => boolean;
	/** stop a released device's `warden ui` helper (best effort; absent = nothing to stop) */
	stopHelper?: (udid: string) => Promise<void>;
};

const SIM_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_UDID = /^[0-9a-f]{8}-[0-9a-f]{16}$/i;

export type DeviceTarget = { kind: "device"; platform: Platform; id: string } | { kind: "skip" };

/** iOS = UDID shape; `chromium-cdp-*` is not a device warden leases; anything else = adb serial. */
export function deviceTarget(id: string): DeviceTarget {
	if (id.length === 0 || id.startsWith("chromium-cdp-")) return { kind: "skip" };
	if (SIM_UDID.test(id) || PHONE_UDID.test(id)) return { kind: "device", platform: "ios", id };
	return { kind: "device", platform: "android", id };
}

function startWorker(deps: HookDeps, sessionId: string): boolean {
	try {
		return deps.endInBackground(sessionId);
	} catch {
		return false;
	}
}

/**
 * A lease a running process still holds: its pid is alive and it heartbeats (within the TTL), as a
 * `warden e2e` / `batch` / `run` / `dev` the agent started in a background shell does.
 */
function heldByLiveProcess(lease: Lease, now: number, pidAlive: PidAlive): boolean {
	return lease.pid !== undefined && now - lease.heartbeatAt <= lease.ttlMs && pidAlive(lease.pid);
}

/** The session's leases to release now, and (on `/clear`) the ones a live process keeps. */
function splitHeld(owned: Lease[], keepRunning: boolean, deps: HookDeps): { leases: Lease[]; kept: Lease[] } {
	if (!keepRunning) return { leases: owned, kept: [] };
	const now = deps.now();
	const kept = owned.filter((l) => heldByLiveProcess(l, now, deps.pidAlive));
	return { leases: owned.filter((l) => !kept.includes(l)), kept };
}

/** `warden: released …` first, `warden: kept …` last (each only when there is one). */
function outcomeLines(released: Lease[], kept: Lease[], lines: string[]): string[] {
	const out = released.length > 0 ? [`warden: released ${released.map((l) => l.id).join(" ")}`, ...lines] : lines;
	if (kept.length === 0) return out;
	const pids = [...new Set(kept.map((l) => l.pid))].join(" ");
	return [...out, `warden: kept ${kept.map((l) => l.id).join(" ")} (held by running warden pid ${pids})`];
}

/**
 * SessionEnd: shut down the session's devices the shutdown policy allows (warden-created, or booted
 * by this session) so nothing is left running, then release every lease the session holds. On
 * `/clear` (reason `clear`) devices stay up — the conversation restarts but the work usually goes on
 * with the same sim, which the new session re-claims with its next `warden claim` — and leases a
 * live process holds (a background `warden e2e` / `batch`, see `heldByLiveProcess`) are kept: that
 * run releases them itself when it ends. When there are devices to shut down the work goes to a
 * detached worker (`warden release --session S --shutdown`, which shuts down before releasing) so
 * the hook returns inside the agent's time cap; inline otherwise.
 */
export async function handleSessionEnd(raw: unknown, deps: HookDeps): Promise<HookResult> {
	try {
		const sessionId = isRecord(raw) ? stringField(raw, "session_id") : undefined;
		if (!sessionId || !isRecord(raw)) return { exitCode: 0 };
		const owner: AgentOwner = { kind: "agent", sessionId, cwd: "" };
		const store = deps.store();
		const owned = store.listLeasesByOwner(owner);
		const lines: string[] = [];
		const keepRunning = stringField(raw, "reason") === "clear";
		const { leases, kept } = splitHeld(owned, keepRunning, deps);
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
		await releaseDevices(
			deps,
			leases.map((l) => l.id),
			{ after: deps.stopHelper }
		);
		const out = outcomeLines(leases, kept, lines);
		return out.length > 0 ? { exitCode: 0, stdout: out.join("\n") } : { exitCode: 0 };
	} catch (error) {
		return { exitCode: 0, stderr: `warden hook session-end: ${errorMessage(error)}` };
	}
}
