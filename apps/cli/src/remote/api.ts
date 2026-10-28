import { type AsyncResult, ok, type Result } from "@delacour/warden-types/result";
import type {
	ApiError,
	CreateRemoteDevice,
	DeviceCode,
	DeviceTokenPoll,
	Me,
	Organization,
	RemoteDevice,
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
	createDevice: (request: CreateRemoteDevice) => AsyncResult<RemoteDevice, ApiError>;
	getDevice: (id: string) => AsyncResult<RemoteDevice, ApiError>;
	listDevices: () => AsyncResult<RemoteDevice[], ApiError>;
	stopDevice: (id: string) => AsyncResult<{ stopped: boolean }, ApiError>;
	/** push the device's idle deadline out by its idle timeout (what `warden heartbeat` does for remote leases) */
	heartbeatDevice: (id: string) => AsyncResult<RemoteDevice, ApiError>;
};

export type WardenApiOptions = { baseUrl: string; token?: string; fetch?: Fetch };

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
	return { kind: "http", status, ...(code ? { code } : {}), message };
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
	};
}

function parseOrganization(value: unknown): Organization | undefined {
	if (!isRecord(value)) return undefined;
	const id = str(value.id);
	const name = str(value.name);
	const slug = str(value.slug);
	return id && name && slug ? { id, name, slug } : undefined;
}

function parseMe(value: unknown): Me | undefined {
	if (!isRecord(value) || !isRecord(value.user)) return undefined;
	const id = str(value.user.id);
	const email = str(value.user.email);
	if (!id || !email) return undefined;
	const name = str(value.user.name);
	const organization = value.organization === null ? null : parseOrganization(value.organization);
	if (organization === undefined) return undefined;
	const remote = value.remote;
	let parsedRemote: Me["remote"] = null;
	if (isRecord(remote)) {
		const state = remote.state;
		if (
			state !== "pending" &&
			state !== "connected" &&
			state !== "awaiting_approval" &&
			state !== "failed" &&
			state !== "disconnected"
		) {
			return undefined;
		}
		const active = typeof remote.active === "number" ? remote.active : 0;
		parsedRemote = {
			state,
			active,
			...(typeof remote.concurrencyLimit === "number" ? { concurrencyLimit: remote.concurrencyLimit } : {}),
		};
	}
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
		body?: unknown
	): AsyncResult<{ status: number; body: unknown }, ApiError> {
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (options.token) headers.authorization = `Bearer ${options.token}`;
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
		body?: unknown
	): AsyncResult<T, ApiError> {
		const r = await send(method, path, body);
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
		createDevice: (request) => call("POST", "/v1/devices", parseDevice, request),
		getDevice: (id) => call("GET", `/v1/devices/${encodeURIComponent(id)}`, parseDevice),
		listDevices: () =>
			call("GET", "/v1/devices", (b) => {
				if (!Array.isArray(b)) return undefined;
				const devices = b.map(parseDevice);
				return devices.every((d) => d !== undefined) ? devices.filter((d) => d !== undefined) : undefined;
			}),
		heartbeatDevice: (id) => call("POST", `/v1/devices/${encodeURIComponent(id)}/heartbeat`, parseDevice, {}),
		stopDevice: (id) =>
			call("DELETE", `/v1/devices/${encodeURIComponent(id)}`, (b) =>
				isRecord(b) && typeof b.stopped === "boolean" ? { stopped: b.stopped } : undefined
			),
	};
}
