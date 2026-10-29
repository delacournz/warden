/**
 * The warden-api shapes the CLI speaks. Provisional: replaced by `@delacour/warden-api` (generated from the
 * server's OpenAPI document) once that package is published; field names here are the contract it must keep.
 */

export type RemotePlatform = "ios" | "android";

export type RemoteDeviceStatus = "starting" | "ready" | "stopping" | "stopped" | "failed";

export type RemoteDevice = {
	id: string;
	platform: RemotePlatform;
	status: RemoteDeviceStatus;
	deviceModel?: string;
	osVersion?: string;
	idleTimeoutS: number;
	startedAt: string;
	readyAt?: string;
	error?: string;
};

export type CreateRemoteDevice = {
	platform: RemotePlatform;
	deviceModel?: string;
	osVersion?: string;
	buildId?: string;
	idleTimeoutS?: number;
};

/** What a viewer window may do: `view` only watches, `drive` also taps, swipes and types. */
export type ViewerScope = "view" | "drive";

/** `POST /v1/devices/:id/viewer-token`: a short-lived bearer valid only for that device's stream (and input, when `drive`). */
export type ViewerToken = { token: string; expiresAt: string };

export type RemoteConnectionState = "pending" | "connected" | "awaiting_approval" | "failed" | "disconnected";

/** `GET /v1/me`. */
export type Me = {
	user: { id: string; email: string; name?: string };
	organization: { id: string; name: string; slug: string } | null;
	remote: { state: RemoteConnectionState; concurrencyLimit?: number; active: number } | null;
};

export type Organization = { id: string; name: string; slug: string };

/** better-auth device authorization (`POST /api/auth/device/code`, RFC 8628). */
export type DeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
	interval: number;
};

/** One poll of `POST /api/auth/device/token`. */
export type DeviceTokenPoll =
	| { kind: "token"; token: string }
	| { kind: "pending" }
	| { kind: "slow_down" }
	| { kind: "denied" }
	| { kind: "expired" };

export type ApiError =
	| { kind: "network"; message: string }
	| { kind: "unauthorized"; message: string }
	| { kind: "forbidden"; code?: string; message: string }
	| { kind: "not_found"; message: string }
	| { kind: "http"; status: number; code?: string; message: string }
	| { kind: "invalid_response"; message: string };
