import { type AsyncResult, ok, type Result } from "@delacour/warden-types/result";
import type {
	ApiError,
	Billing,
	CreateRemoteDevice,
	DeviceBilling,
	DeviceCode,
	DeviceTokenPoll,
	LedgerEntry,
	LedgerKind,
	LedgerPage,
	Me,
	Organization,
	RemoteConnectionState,
	RemoteDevice,
	RevylApproval,
	SlugAvailability,
	StopReason,
	Topup,
	TrialState,
	ViewerScope,
	ViewerToken,
} from "./api.types";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The OAuth client id warden-api's device-authorization plugin accepts for `warden login`. */
export const WARDEN_CLI_CLIENT_ID = "warden-cli";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Everything the CLI asks warden-api. `token` unset = only the login endpoints work. */
export type WardenApi = {
	deviceCode: () => AsyncResult<DeviceCode, ApiError>;
	deviceToken: (deviceCode: string) => AsyncResult<DeviceTokenPoll, ApiError>;
	me: () => AsyncResult<Me, ApiError>;
	signOut: () => AsyncResult<void, ApiError>;
	listOrganizations: () => AsyncResult<Organization[], ApiError>;
	setActiveOrganization: (organizationId: string) => AsyncResult<void, ApiError>;
	/** better-auth `check-slug`: `taken` is its `ORGANIZATION_SLUG_ALREADY_TAKEN`; any other failure is an error. */
	checkOrganizationSlug: (slug: string) => AsyncResult<SlugAvailability, ApiError>;
	/** Create an organization you own; better-auth makes it the session's active one. */
	createOrganization: (input: { name: string; slug: string }) => AsyncResult<Organization, ApiError>;
	/** `machine` = the hashed machine id, sent as `X-Warden-Machine` (it activates the free trial) */
	createDevice: (request: CreateRemoteDevice, opts?: { machine?: string }) => AsyncResult<RemoteDevice, ApiError>;
	getDevice: (id: string) => AsyncResult<RemoteDevice, ApiError>;
	listDevices: () => AsyncResult<RemoteDevice[], ApiError>;
	stopDevice: (id: string) => AsyncResult<{ stopped: boolean }, ApiError>;
	/** push the device's idle deadline out by its idle timeout (what `warden heartbeat` does for remote leases) */
	heartbeatDevice: (id: string) => AsyncResult<RemoteDevice, ApiError>;
	/** mint a viewer token for one device; `ttlS` is clamped server-side to 60..1800 (default 600) */
	viewerToken: (id: string, scope: ViewerScope, ttlS?: number) => AsyncResult<ViewerToken, ApiError>;
	/** record this machine's hashed id against the user (after `warden login`) */
	registerMachine: (hash: string) => AsyncResult<void, ApiError>;
	getBilling: () => AsyncResult<Billing, ApiError>;
	/** newest first */
	listLedger: (opts?: { limit?: number; cursor?: string }) => AsyncResult<LedgerPage, ApiError>;
	/** owner/admin only (403 `BILLING_ROLE` otherwise) */
	createTopup: (amountUsd: number) => AsyncResult<Topup, ApiError>;
};

/** `organization` (id or slug) is sent as `X-Warden-Organization` with a token: the org this call acts for. */
export type WardenApiOptions = { baseUrl: string; token?: string; organization?: string; fetch?: Fetch };

function fail<E>(error: E): { success: false; error: E } {
	return { success: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Map a non-2xx body (warden-api's `{success:false,error,code}` or better-auth's `{message,code}`) to an ApiError. */
function httpError(status: number, body: unknown): ApiError {
	const record = isRecord(body) ? body : {};
	const message = str(record.error) ?? str(record.message) ?? `HTTP ${status}`;
	const code = str(record.code);
	if (status === 401) return { kind: "unauthorized", message };
	if (status === 403) return { kind: "forbidden", ...(code ? { code } : {}), message };
	if (status === 404) return { kind: "not_found", message };
	if (status === 402) {
		const billingUrl = str(record.billingUrl);
		return { kind: "payment_required", ...(code ? { code } : {}), message, ...(billingUrl ? { billingUrl } : {}) };
	}
	return { kind: "http", status, ...(code ? { code } : {}), message };
}

/** better-auth's error code for a slug another organization has. */
export const SLUG_TAKEN = "ORGANIZATION_SLUG_ALREADY_TAKEN";

const STOP_REASONS: readonly StopReason[] = ["user", "idle", "credits_exhausted", "error"];
const TRIAL_STATES: readonly TrialState[] = ["none", "held", "active", "revoked"];
const LEDGER_KINDS: readonly LedgerKind[] = ["grant", "grant_revoked", "topup", "usage", "refund", "dispute", "adjust"];

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function oneOf<T extends string>(values: readonly T[], v: unknown): T | undefined {
	return values.find((x) => x === v);
}

function parseDeviceBilling(value: unknown): DeviceBilling | undefined {
	if (!isRecord(value)) return undefined;
	const balanceUsd = num(value.balanceUsd);
	return balanceUsd !== undefined && typeof value.lowBalance === "boolean"
		? { balanceUsd, lowBalance: value.lowBalance }
		: undefined;
}

function parseBilling(value: unknown): Billing | undefined {
	if (!isRecord(value) || !isRecord(value.trial)) return undefined;
	const balanceUsd = num(value.balanceUsd);
	const ratePerMinuteUsd = num(value.ratePerMinuteUsd);
	const estMinutesLeft = num(value.estMinutesLeft);
	const state = oneOf(TRIAL_STATES, value.trial.state);
	const amountUsd = num(value.trial.amountUsd);
	const billingUrl = str(value.billingUrl);
	if (
		balanceUsd === undefined ||
		ratePerMinuteUsd === undefined ||
		estMinutesLeft === undefined ||
		typeof value.lowBalance !== "boolean" ||
		state === undefined ||
		amountUsd === undefined ||
		billingUrl === undefined
	) {
		return undefined;
	}
	return {
		balanceUsd,
		ratePerMinuteUsd,
		estMinutesLeft,
		lowBalance: value.lowBalance,
		trial: { state, amountUsd },
		billingUrl,
	};
}

/** Amounts come as `amountUsd`, or as integer `amountMicrousd` (the ledger's unit). */
function parseLedgerEntry(value: unknown): LedgerEntry | undefined {
	if (!isRecord(value)) return undefined;
	const id = str(value.id);
	const createdAt = str(value.createdAt);
	const micro = num(value.amountMicrousd);
	const amountUsd = num(value.amountUsd) ?? (micro !== undefined ? micro / 1_000_000 : undefined);
	if (!id || !createdAt || amountUsd === undefined) return undefined;
	return { id, kind: oneOf(LEDGER_KINDS, value.kind) ?? "other", amountUsd, createdAt };
}

function parseLedgerPage(value: unknown): LedgerPage | undefined {
	const rows = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.entries)
			? value.entries
			: undefined;
	if (!rows) return undefined;
	const entries = rows.map(parseLedgerEntry);
	if (!entries.every((e) => e !== undefined)) return undefined;
	const nextCursor = isRecord(value) ? str(value.nextCursor) : undefined;
	return { entries: entries.filter((e) => e !== undefined), ...(nextCursor ? { nextCursor } : {}) };
}

function parseDevice(value: unknown): RemoteDevice | undefined {
	if (!isRecord(value)) return undefined;
	const { id, platform, status, idleTimeoutS, startedAt } = value;
	if (typeof id !== "string" || (platform !== "ios" && platform !== "android")) return undefined;
	if (
		status !== "starting" &&
		status !== "ready" &&
		status !== "stopping" &&
		status !== "stopped" &&
		status !== "failed"
	) {
		return undefined;
	}
	if (typeof idleTimeoutS !== "number" || typeof startedAt !== "string") return undefined;
	const optional = (key: "deviceModel" | "osVersion" | "readyAt" | "error") => {
		const v = str(value[key]);
		return v !== undefined ? { [key]: v } : {};
	};
	const stopReason = oneOf(STOP_REASONS, value.stopReason);
	const billing = parseDeviceBilling(value.billing);
	return {
		id,
		platform,
		status,
		idleTimeoutS,
		startedAt,
		...optional("deviceModel"),
		...optional("osVersion"),
		...optional("readyAt"),
		...optional("error"),
		...(stopReason ? { stopReason } : {}),
		...(billing ? { billing } : {}),
	};
}

function parseOrganization(value: unknown): Organization | undefined {
	if (!isRecord(value)) return undefined;
	const id = str(value.id);
	const name = str(value.name);
	const slug = str(value.slug);
	return id && name && slug ? { id, name, slug } : undefined;
}

function parseViewerToken(value: unknown): ViewerToken | undefined {
	if (!isRecord(value)) return undefined;
	const token = str(value.token);
	const expiresAt = str(value.expiresAt);
	return token && expiresAt ? { token, expiresAt } : undefined;
}

const REMOTE_STATES: readonly RemoteConnectionState[] = [
	"pending",
	"connected",
	"awaiting_approval",
	"failed",
	"disconnected",
];

/** `GET /v1/me`'s `remote`: `null` when not set up, `undefined` when malformed. */
function parseRemote(remote: unknown): Me["remote"] | undefined {
	if (!isRecord(remote)) return null;
	const state = oneOf(REMOTE_STATES, remote.state);
	if (state === undefined) return undefined;
	const balanceUsd = num(remote.balanceUsd);
	const approval = parseApproval(remote.approval);
	return {
		state,
		active: typeof remote.active === "number" ? remote.active : 0,
		...(typeof remote.concurrencyLimit === "number" ? { concurrencyLimit: remote.concurrencyLimit } : {}),
		...(balanceUsd !== undefined ? { balanceUsd } : {}),
		...(approval ? { approval } : {}),
		...(typeof remote.dashboard === "boolean" ? { dashboard: remote.dashboard } : {}),
	};
}

/** `remote.approval`: the Revyl connect code, or `undefined` when absent or malformed. */
function parseApproval(value: unknown): RevylApproval | undefined {
	if (!isRecord(value)) return undefined;
	const userCode = str(value.userCode);
	const uri = str(value.uri);
	const expiresAt = str(value.expiresAt);
	return userCode && uri && expiresAt ? { userCode, uri, expiresAt } : undefined;
}

function parseMe(value: unknown): Me | undefined {
	if (!isRecord(value) || !isRecord(value.user)) return undefined;
	const id = str(value.user.id);
	const email = str(value.user.email);
	if (!id || !email) return undefined;
	const name = str(value.user.name);
	const organization = value.organization === null ? null : parseOrganization(value.organization);
	if (organization === undefined) return undefined;
	const parsedRemote = parseRemote(value.remote);
	if (parsedRemote === undefined) return undefined;
	return { user: { id, email, ...(name ? { name } : {}) }, organization, remote: parsedRemote };
}

function parseDeviceCode(b: unknown): DeviceCode | undefined {
	if (!isRecord(b)) return undefined;
	const deviceCode = str(b.device_code);
	const userCode = str(b.user_code);
	const verificationUri = str(b.verification_uri);
	const complete = str(b.verification_uri_complete);
	if (!deviceCode || !userCode || !verificationUri || typeof b.expires_in !== "number") return undefined;
	return {
		deviceCode,
		userCode,
		verificationUri,
		...(complete ? { verificationUriComplete: complete } : {}),
		expiresIn: b.expires_in,
		interval: typeof b.interval === "number" ? b.interval : 5,
	};
}

export function createWardenApi(options: WardenApiOptions): WardenApi {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));

	/** One request → parsed JSON body (or `undefined` for an empty one) + status; network errors are ApiErrors. */
	async function send(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders: Record<string, string> = {}
	): AsyncResult<{ status: number; body: unknown }, ApiError> {
		const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (options.token) headers.authorization = `Bearer ${options.token}`;
		if (options.token && options.organization) headers["x-warden-organization"] = options.organization;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl}${path}`, {
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
		} catch (e) {
			return fail({ kind: "network", message: e instanceof Error ? e.message : String(e) });
		}
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = text;
		}
		return ok({ status: response.status, body: parsed });
	}

	async function call<T>(
		method: string,
		path: string,
		parse: (body: unknown) => T | undefined,
		body?: unknown,
		headers?: Record<string, string>
	): AsyncResult<T, ApiError> {
		const r = await send(method, path, body, headers);
		if (!r.success) return r;
		const { status, body: data } = r.data;
		if (status < 200 || status >= 300) return fail(httpError(status, data));
		const value = parse(data);
		return value === undefined
			? fail({ kind: "invalid_response", message: `unexpected response from ${method} ${path}` })
			: ok(value);
	}

	const done = (): true => true;
	const asVoid = (r: Result<true, ApiError>): Result<void, ApiError> => (r.success ? ok(undefined) : r);

	return {
		deviceCode: () => call("POST", "/api/auth/device/code", parseDeviceCode, { client_id: WARDEN_CLI_CLIENT_ID }),

		deviceToken: async (deviceCode) => {
			const r = await send("POST", "/api/auth/device/token", {
				grant_type: DEVICE_GRANT,
				device_code: deviceCode,
				client_id: WARDEN_CLI_CLIENT_ID,
			});
			if (!r.success) return r;
			const { status, body } = r.data;
			const record = isRecord(body) ? body : {};
			const token = str(record.access_token);
			if (status >= 200 && status < 300 && token) return ok({ kind: "token", token });
			switch (str(record.error)) {
				case "authorization_pending":
					return ok({ kind: "pending" });
				case "slow_down":
					return ok({ kind: "slow_down" });
				case "access_denied":
					return ok({ kind: "denied" });
				case "expired_token":
					return ok({ kind: "expired" });
				default:
					return fail(httpError(status, body));
			}
		},

		me: () => call("GET", "/v1/me", parseMe),
		signOut: async () => asVoid(await call("POST", "/api/auth/sign-out", done, {})),
		listOrganizations: () =>
			call("GET", "/api/auth/organization/list", (b) => {
				if (!Array.isArray(b)) return undefined;
				const orgs = b.map(parseOrganization);
				return orgs.every((o) => o !== undefined) ? orgs.filter((o) => o !== undefined) : undefined;
			}),
		setActiveOrganization: async (organizationId) =>
			asVoid(await call("POST", "/api/auth/organization/set-active", done, { organizationId })),
		checkOrganizationSlug: async (slug) => {
			const checked = await call("POST", "/api/auth/organization/check-slug", done, { slug });
			if (checked.success) return ok("available");
			return "code" in checked.error && checked.error.code === SLUG_TAKEN ? ok("taken") : checked;
		},
		createOrganization: (input) => call("POST", "/api/auth/organization/create", parseOrganization, input),
		createDevice: (request, opts) =>
			call("POST", "/v1/devices", parseDevice, request, opts?.machine ? { "x-warden-machine": opts.machine } : {}),
		getDevice: (id) => call("GET", `/v1/devices/${encodeURIComponent(id)}`, parseDevice),
		listDevices: () =>
			call("GET", "/v1/devices", (b) => {
				if (!Array.isArray(b)) return undefined;
				const devices = b.map(parseDevice);
				return devices.every((d) => d !== undefined) ? devices.filter((d) => d !== undefined) : undefined;
			}),
		heartbeatDevice: (id) => call("POST", `/v1/devices/${encodeURIComponent(id)}/heartbeat`, parseDevice, {}),
		viewerToken: (id, scope, ttlS) =>
			call("POST", `/v1/devices/${encodeURIComponent(id)}/viewer-token`, parseViewerToken, {
				scope,
				...(ttlS !== undefined ? { ttlS } : {}),
			}),
		registerMachine: async (hash) => asVoid(await call("POST", "/v1/machines", done, { hash })),
		getBilling: () => call("GET", "/v1/billing", parseBilling),
		listLedger: (opts = {}) => {
			const query = new URLSearchParams();
			if (opts.limit !== undefined) query.set("limit", String(opts.limit));
			if (opts.cursor) query.set("cursor", opts.cursor);
			const qs = query.toString();
			return call("GET", `/v1/billing/ledger${qs ? `?${qs}` : ""}`, parseLedgerPage);
		},
		createTopup: (amountUsd) =>
			call(
				"POST",
				"/v1/billing/topups",
				(b) => (isRecord(b) && typeof b.checkoutUrl === "string" ? { checkoutUrl: b.checkoutUrl } : undefined),
				{ amountUsd }
			),
		stopDevice: (id) =>
			call("DELETE", `/v1/devices/${encodeURIComponent(id)}`, (b) =>
				isRecord(b) && typeof b.stopped === "boolean" ? { stopped: b.stopped } : undefined
			),
	};
}
