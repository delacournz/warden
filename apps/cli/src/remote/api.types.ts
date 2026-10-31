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
	/** why a stopped device stopped */
	stopReason?: StopReason;
	/** the org's balance, on get and heartbeat */
	billing?: DeviceBilling;
};

export type StopReason = "user" | "idle" | "credits_exhausted" | "error";

export type DeviceBilling = { balanceUsd: number; lowBalance: boolean };

export type TrialState = "none" | "held" | "active" | "revoked";

/** `GET /v1/billing`: the active organization's prepaid balance. */
export type Billing = {
	balanceUsd: number;
	ratePerMinuteUsd: number;
	estMinutesLeft: number;
	lowBalance: boolean;
	trial: { state: TrialState; amountUsd: number };
	/** the web page to top up on */
	billingUrl: string;
};

export type LedgerKind = "grant" | "grant_revoked" | "topup" | "usage" | "refund" | "dispute" | "adjust";

/** One `GET /v1/billing/ledger` entry; a kind this CLI doesn't know reads as `other`. */
export type LedgerEntry = { id: string; kind: LedgerKind | "other"; amountUsd: number; createdAt: string };

export type LedgerPage = { entries: LedgerEntry[]; nextCursor?: string };

/** `POST /v1/billing/topups`: the Stripe Checkout page to pay on. */
export type Topup = { checkoutUrl: string };

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
	remote: {
		state: RemoteConnectionState;
		concurrencyLimit?: number;
		active: number;
		balanceUsd?: number;
		/** Only while `awaiting_approval`, and only for the org owner: the Revyl connect code. */
		approval?: RevylApproval | null;
		/** Whether this member can open the org's Revyl dashboard from warden-web. */
		dashboard?: boolean;
	} | null;
};

/** The owner already has a Revyl account: they approve warden at `uri` with `userCode` before devices start. */
export type RevylApproval = { userCode: string; uri: string; expiresAt: string };

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
	| { kind: "payment_required"; code?: string; message: string; billingUrl?: string }
	| { kind: "http"; status: number; code?: string; message: string }
	| { kind: "invalid_response"; message: string };
