import { resultFactory } from "@delacour/warden-types/result";
import { z } from "zod";
import { type DevtoolsResult, devtoolsErrors, type Fetch } from "./devtools.types";

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

/** Lists and picks Metro's inspector targets. Use the shared {@link inspectorTargets} singleton. */
export class InspectorTargets {
	/**
	 * Metro's debuggable pages. `/status` must say `packager-status:running` (something else on the port is
	 * not Metro), then `/json/list` (`/json` on older Metro). Decoy `vm` entries are dropped.
	 */
	async list(metroUrl: string, fetch: Fetch): Promise<DevtoolsResult<InspectorTarget[]>> {
		const base = metroUrl.replace(/\/+$/, "");
		const status = await this.get(fetch, `${base}/status`);
		if (!status) return this.unavailable(`Metro is not reachable at ${base}`);
		if (!status.body.includes(STATUS_RUNNING)) {
			return this.unavailable(`${base} did not answer like Metro (got: ${status.body.slice(0, 80)})`);
		}
		for (const path of ["/json/list", "/json"]) {
			const res = await this.get(fetch, `${base}${path}`);
			if (!res?.ok) continue;
			const targets = this.parseTargets(res.body);
			if (targets) return resultFactory.ok(targets.filter((t) => t.vm !== DECOY_VM));
		}
		return this.unavailable(`Metro at ${base} listed no inspector targets (/json/list and /json failed)`);
	}

	/**
	 * Pick the page to debug: the pinned `logicalDeviceId`, else `deviceName`; then `appId`; then Fusebox over the
	 * legacy `React Native Bridge` page over anything, newest page id first. A pin or name that matches nothing is
	 * `device_mismatch` when Metro serves several devices (never attach to the wrong one), and ignored when it serves one.
	 */
	select(targets: readonly InspectorTarget[], query: TargetQuery, metroUrl: string): DevtoolsResult<SelectedTarget> {
		if (targets.length === 0) {
			return this.unavailable("Metro has no inspector targets: is the app running a dev client?");
		}
		const narrowed = this.narrowToDevice([...targets], query);
		if (!narrowed.success) return narrowed;
		let candidates = narrowed.data;
		if (query.appId) {
			const byApp = candidates.filter((t) => t.appId === query.appId);
			if (byApp.length > 0) candidates = byApp;
		}
		candidates.sort((a, b) => this.newestFirst(a, b));
		const fuseboxTarget = candidates.find((t) => this.isFusebox(t));
		const bridge = candidates.find((t) => t.title?.startsWith("React Native Bridge"));
		const chosen = fuseboxTarget ?? bridge ?? candidates[0];
		if (!chosen) return this.unavailable("Metro has no inspector targets: is the app running a dev client?");
		return resultFactory.ok({
			wsUrl: this.normalizeWsUrl(chosen.webSocketDebuggerUrl, metroUrl),
			deviceName: chosen.deviceName ?? chosen.title ?? "unknown",
			appId: chosen.appId,
			logicalDeviceId: this.logicalIdOf(chosen),
			fusebox: fuseboxTarget !== undefined,
			id: chosen.id,
			title: chosen.title,
		});
	}

	private unavailable(message: string) {
		return devtoolsErrors.err("devtools_unavailable", message);
	}

	private async get(fetch: Fetch, url: string): Promise<{ ok: boolean; status: number; body: string } | undefined> {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
			return { ok: res.ok, status: res.status, body: await res.text() };
		} catch {
			return undefined;
		}
	}

	private parseTargets(body: string): InspectorTarget[] | undefined {
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

	/** The pinned `logicalDeviceId`, else `deviceName`, narrowed in turn; `device_mismatch` when Metro serves several. */
	private narrowToDevice(candidates: InspectorTarget[], query: TargetQuery): DevtoolsResult<InspectorTarget[]> {
		const wanted: [string | undefined, (t: InspectorTarget) => boolean, string][] = [
			[
				query.logicalDeviceId,
				(t) => t.reactNative?.logicalDeviceId === query.logicalDeviceId || this.urlDevice(t) === query.logicalDeviceId,
				"logicalDeviceId",
			],
			[
				query.deviceName,
				(t) => t.deviceName !== undefined && this.sameDeviceName(t.deviceName, query.deviceName),
				"deviceName",
			],
		];
		for (const [value, matches, label] of wanted) {
			if (!value) continue;
			const filtered = candidates.filter(matches);
			if (filtered.length > 0) return resultFactory.ok(filtered);
			if (new Set(candidates.map((t) => this.deviceKey(t))).size > 1) {
				return devtoolsErrors.err(
					"device_mismatch",
					`No debugger target matches ${label} "${value}". Metro serves: ${this.describeDevices(candidates)}`
				);
			}
		}
		return resultFactory.ok(candidates);
	}

	private urlDevice(target: InspectorTarget): string | undefined {
		try {
			return new URL(target.webSocketDebuggerUrl).searchParams.get("device") ?? undefined;
		} catch {
			return undefined;
		}
	}

	private logicalIdOf(target: InspectorTarget): string | undefined {
		return target.reactNative?.logicalDeviceId ?? this.urlDevice(target);
	}

	/** One physical device = one logical id, else the `?device=` param, else its name. */
	private deviceKey(target: InspectorTarget): string {
		return this.logicalIdOf(target) ?? target.deviceName ?? target.id;
	}

	/** Metro ids are `<device>-<page>`; the page counter only grows, so the larger one is newer. */
	private pageNumber(target: InspectorTarget): number {
		const n = Number.parseInt(target.id.slice(target.id.lastIndexOf("-") + 1), 10);
		return Number.isNaN(n) ? -1 : n;
	}

	private newestFirst(a: InspectorTarget, b: InspectorTarget): number {
		return this.pageNumber(b) - this.pageNumber(a) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
	}

	private isFusebox(t: InspectorTarget): boolean {
		return (
			t.reactNative?.capabilities?.prefersFuseboxFrontend === true ||
			t.description?.endsWith("[C++ connection]") === true
		);
	}

	private describeDevices(targets: readonly InspectorTarget[]): string {
		const seen = new Map<string, string>();
		for (const t of targets) {
			const key = this.deviceKey(t);
			if (!seen.has(key))
				seen.set(key, `${t.deviceName ?? "unknown"} (${this.logicalIdOf(t) ?? "no logicalDeviceId"})`);
		}
		return [...seen.values()].join(", ");
	}

	/**
	 * The dev client sends its device name in a query string that Metro form-decodes, so a `+` in a simulator name
	 * (`warden-iphone-17+bio-1`) reaches the inspector as a space.
	 */
	private sameDeviceName(served: string, wanted: string | undefined): boolean {
		return wanted !== undefined && served.replaceAll("+", " ") === wanted.replaceAll("+", " ");
	}

	private normalizeWsUrl(wsUrl: string, metroUrl: string): string {
		const ws = new URL(wsUrl);
		const metro = new URL(metroUrl);
		ws.protocol = metro.protocol === "https:" ? "wss:" : "ws:";
		ws.hostname = metro.hostname;
		ws.port = metro.port;
		return ws.toString();
	}
}

export const inspectorTargets = new InspectorTargets();
