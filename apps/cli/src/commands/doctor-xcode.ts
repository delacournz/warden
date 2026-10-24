import type { Exec } from "@delacour/warden-core/exec";
import { readXcode } from "@delacour/warden-core/xcode";
import { detectSimViewer } from "../sim-windows";
import type { CheckStatus, DoctorCheck } from "./doctor";

type Probe = { ok: true; detail: string } | { ok: false; detail: string };

export type McpStatus = { enabled: boolean; running: boolean; allowAll: boolean; openWorkspaces: number };

const MIN_MCP_MAJOR = 27;
const TIMEOUT_MS = 10_000;

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

/** `xcrun mcp-server status --format json` (Xcode 27.1): `{ openWorkspaces: [], permission: { enabled, unsafeAlwaysAllowAllAgents }, running }`. */
export function parseMcpStatus(stdout: string): { success: true; data: McpStatus } | { success: false; error: string } {
	let json: unknown;
	try {
		json = JSON.parse(stdout);
	} catch {
		return { success: false, error: "mcp-server status is not JSON" };
	}
	const permission = field(json, "permission");
	const running = field(json, "running");
	if (typeof field(permission, "enabled") !== "boolean" || typeof running !== "boolean") {
		return { success: false, error: "unexpected mcp-server status shape" };
	}
	const workspaces = field(json, "openWorkspaces");
	return {
		success: true,
		data: {
			enabled: field(permission, "enabled") === true,
			running,
			allowAll: field(permission, "unsafeAlwaysAllowAllAgents") === true,
			openWorkspaces: Array.isArray(workspaces) ? workspaces.length : 0,
		},
	};
}

/** Xcode's agent bridge. Informational: absent or Xcode ≤ 26 is fine; only allow-all-agents warns. */
export async function mcpStatusProbe(exec: Exec, major: number | undefined): Promise<Probe> {
	const bridge = await exec(["xcrun", "--find", "mcpbridge"], { timeoutMs: TIMEOUT_MS });
	if (bridge.exitCode !== 0)
		return { ok: true, detail: "mcpbridge not available (Xcode's agent tools are not installed)" };
	if (major === undefined || major < MIN_MCP_MAJOR) {
		return { ok: true, detail: `mcpbridge present; headless \`mcp-server\` needs Xcode ${MIN_MCP_MAJOR}` };
	}
	const status = await exec(["xcrun", "mcp-server", "status", "--format", "json"], { timeoutMs: TIMEOUT_MS });
	const parsed = status.exitCode === 0 ? parseMcpStatus(status.stdout) : undefined;
	if (!parsed?.success) return { ok: true, detail: "mcpbridge present; `mcp-server status` unreadable" };
	const s = parsed.data;
	const detail = `mcpbridge present; headless ${s.enabled ? "enabled" : "disabled"}, ${s.running ? "running" : "not running"}, ${s.openWorkspaces} open workspace${s.openWorkspaces === 1 ? "" : "s"}`;
	return s.allowAll
		? {
				ok: false,
				detail: `${detail}; unsafeAlwaysAllowAllAgents is on — any agent can drive any booted sim, skipping warden leases`,
			}
		: { ok: true, detail };
}

/** Which simulator viewer is up (Simulator.app: warden tiles/closes per-device windows; Device Hub: opens and tiles them, never closes). */
export async function viewerProbe(exec: Exec): Promise<Probe> {
	const viewer = await detectSimViewer(exec);
	switch (viewer.kind) {
		case "simulator":
			return { ok: true, detail: "Simulator.app: warden can tile and close per-device windows" };
		case "device-hub":
			return {
				ok: true,
				detail:
					"Device Hub (Xcode 27): non-headless claims open and tile a window per sim; headless opens none. Quitting Device Hub shuts down every booted sim",
			};
		case "none":
			return { ok: true, detail: "none running (headless)" };
	}
}

function status(probe: Probe): CheckStatus {
	return probe.ok ? "ok" : "warn";
}

/** Xcode version, agent-bridge state and sim viewer. Never `fail`: all optional context for agents. */
export async function xcodeChecks(exec: Exec, env: Record<string, string | undefined>): Promise<DoctorCheck[]> {
	const xcode = await readXcode(exec, env);
	const major = xcode.success ? xcode.data.major : undefined;
	const xcodeProbe: Probe = xcode.success
		? {
				ok: true,
				detail: `Xcode ${xcode.data.version} (${xcode.data.build}) ${xcode.data.path} via ${xcode.data.source}`,
			}
		: { ok: true, detail: `no Xcode selected or readable (${xcode.error})` };
	const [mcp, viewer] = await Promise.all([mcpStatusProbe(exec, major), viewerProbe(exec)]);
	return [
		{ name: "xcode", level: "optional", status: status(xcodeProbe), detail: xcodeProbe.detail },
		{ name: "xcode-mcp", level: "optional", status: status(mcp), detail: mcp.detail },
		{ name: "sim-viewer", level: "optional", status: status(viewer), detail: viewer.detail },
	];
}
