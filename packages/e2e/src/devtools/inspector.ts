import { ok } from "@delacour/warden-types/result";
import { z } from "zod";
import { type DevtoolsResult, devtoolsErr, type Fetch } from "./devtools.types";

/** `vm` Metro gives to the placeholder page it lists for every device; never a real runtime. */
const DECOY_VM = "don't use";
const STATUS_RUNNING = "packager-status:running";
const HTTP_TIMEOUT_MS = 3_000;

/** One entry of Metro's `/json/list` (`/json`). */
export const inspectorTargetSchema = z.looseObject({
	id: z.string(),
	title: z.string().optional(),
	description: z.string().optional(),
	vm: z.string().optional(),
	deviceName: z.string().optional(),
	appId: z.string().optional(),
	webSocketDebuggerUrl: z.string(),
	reactNative: z
		.looseObject({
			logicalDeviceId: z.string().optional(),
			capabilities: z.looseObject({ prefersFuseboxFrontend: z.boolean().optional() }).optional(),
		})
		.optional(),
});

export type InspectorTarget = z.infer<typeof inspectorTargetSchema>;

/** Which target a caller wants; every field narrows, none is required. */
export type TargetQuery = { deviceName?: string; logicalDeviceId?: string; appId?: string };

export type SelectedTarget = {
	/** Metro's inspector socket, host and port rewritten to the Metro URL */
	wsUrl: string;
	deviceName: string;
	appId: string | undefined;
	/** persist this to re-pin the same device after an app restart */
	logicalDeviceId: string | undefined;
	/** the C++ (Fusebox) connection, as opposed to the legacy bridge */
	fusebox: boolean;
	id: string;
	title: string | undefined;
};

function unavailable(message: string) {
	return devtoolsErr("devtools_unavailable", message);
}

async function get(fetch: Fetch, url: string): Promise<{ ok: boolean; status: number; body: string } | undefined> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
		return { ok: res.ok, status: res.status, body: await res.text() };
	} catch {
		return undefined;
	}
}

function parseTargets(body: string): InspectorTarget[] | undefined {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!Array.isArray(json)) return undefined;
	const targets: InspectorTarget[] = [];
	for (const entry of json) {
		const parsed = inspectorTargetSchema.safeParse(entry);
		if (parsed.success) targets.push(parsed.data);
	}
	return targets;
}

/**
 * Metro's debuggable pages. `/status` must say `packager-status:running` (something else on the port is
 * not Metro), then `/json/list` (`/json` on older Metro). Decoy `vm` entries are dropped.
 */
export async function listTargets(metroUrl: string, fetch: Fetch): Promise<DevtoolsResult<InspectorTarget[]>> {
	const base = metroUrl.replace(/\/+$/, "");
	const status = await get(fetch, `${base}/status`);
	if (!status) return unavailable(`Metro is not reachable at ${base}`);
	if (!status.body.includes(STATUS_RUNNING)) {
		return unavailable(`${base} did not answer like Metro (got: ${status.body.slice(0, 80)})`);
	}
	for (const path of ["/json/list", "/json"]) {
		const res = await get(fetch, `${base}${path}`);
		if (!res?.ok) continue;
		const targets = parseTargets(res.body);
		if (targets) return ok(targets.filter((t) => t.vm !== DECOY_VM));
	}
	return unavailable(`Metro at ${base} listed no inspector targets (/json/list and /json failed)`);
}

function urlDevice(target: InspectorTarget): string | undefined {
	try {
		return new URL(target.webSocketDebuggerUrl).searchParams.get("device") ?? undefined;
	} catch {
		return undefined;
	}
}

function logicalIdOf(target: InspectorTarget): string | undefined {
	return target.reactNative?.logicalDeviceId ?? urlDevice(target);
}

/** One physical device = one logical id, else the `?device=` param, else its name. */
function deviceKey(target: InspectorTarget): string {
	return logicalIdOf(target) ?? target.deviceName ?? target.id;
}

/** Metro ids are `<device>-<page>`; the page counter only grows, so the larger one is newer. */
function pageNumber(target: InspectorTarget): number {
	const n = Number.parseInt(target.id.slice(target.id.lastIndexOf("-") + 1), 10);
	return Number.isNaN(n) ? -1 : n;
}

function newestFirst(a: InspectorTarget, b: InspectorTarget): number {
	return pageNumber(b) - pageNumber(a) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
}

const isFusebox = (t: InspectorTarget): boolean =>
	t.reactNative?.capabilities?.prefersFuseboxFrontend === true || t.description?.endsWith("[C++ connection]") === true;

function describeDevices(targets: readonly InspectorTarget[]): string {
	const seen = new Map<string, string>();
	for (const t of targets) {
		const key = deviceKey(t);
		if (!seen.has(key)) seen.set(key, `${t.deviceName ?? "unknown"} (${logicalIdOf(t) ?? "no logicalDeviceId"})`);
	}
	return [...seen.values()].join(", ");
}

function normalizeWsUrl(wsUrl: string, metroUrl: string): string {
	const ws = new URL(wsUrl);
	const metro = new URL(metroUrl);
	ws.protocol = metro.protocol === "https:" ? "wss:" : "ws:";
	ws.hostname = metro.hostname;
	ws.port = metro.port;
	return ws.toString();
}

/**
 * Pick the page to debug: the pinned `logicalDeviceId`, else `deviceName`; then `appId`; then Fusebox over the
 * legacy `React Native Bridge` page over anything, newest page id first. A pin or name that matches nothing is
 * `device_mismatch` when Metro serves several devices (never attach to the wrong one), and ignored when it serves one.
 */
export function selectTarget(
	targets: readonly InspectorTarget[],
	query: TargetQuery,
	metroUrl: string
): DevtoolsResult<SelectedTarget> {
	if (targets.length === 0) return unavailable("Metro has no inspector targets: is the app running a dev client?");
	let candidates = [...targets];
	const wanted: [string | undefined, (t: InspectorTarget) => boolean, string][] = [
		[
			query.logicalDeviceId,
			(t) => t.reactNative?.logicalDeviceId === query.logicalDeviceId || urlDevice(t) === query.logicalDeviceId,
			"logicalDeviceId",
		],
		[query.deviceName, (t) => t.deviceName === query.deviceName, "deviceName"],
	];
	for (const [value, matches, label] of wanted) {
		if (!value) continue;
		const filtered = candidates.filter(matches);
		if (filtered.length > 0) {
			candidates = filtered;
			break;
		}
		if (new Set(candidates.map(deviceKey)).size > 1) {
			return devtoolsErr(
				"device_mismatch",
				`No debugger target matches ${label} "${value}". Metro serves: ${describeDevices(candidates)}`
			);
		}
	}
	if (query.appId) {
		const byApp = candidates.filter((t) => t.appId === query.appId);
		if (byApp.length > 0) candidates = byApp;
	}
	candidates.sort(newestFirst);
	const fuseboxTarget = candidates.find(isFusebox);
	const bridge = candidates.find((t) => t.title?.startsWith("React Native Bridge"));
	const chosen = fuseboxTarget ?? bridge ?? candidates[0];
	if (!chosen) return unavailable("Metro has no inspector targets: is the app running a dev client?");
	return ok({
		wsUrl: normalizeWsUrl(chosen.webSocketDebuggerUrl, metroUrl),
		deviceName: chosen.deviceName ?? chosen.title ?? "unknown",
		appId: chosen.appId,
		logicalDeviceId: logicalIdOf(chosen),
		fusebox: fuseboxTarget !== undefined,
		id: chosen.id,
		title: chosen.title,
	});
}
