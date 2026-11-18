import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	isPasskeyMode,
	isPasskeyUv,
	PASSKEY_MODES,
	PASSKEY_UV,
	type PasskeyCondition,
} from "@delacour/warden-core/conditions/conditions.types";
import { createPasskeyCredential, type PasskeyInput } from "@delacour/warden-core/conditions/passkey-store";
import type { PasskeyOp, PasskeyState } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { fail, recordOf, resolveDeps, withPort } from "./conditions";
import type { UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import type { UiError, UiSuccess } from "./output";
import { runUi, type UiOptionValues } from "./run";
import { forget, save, success } from "./settings";

export type PasskeyOptionValues = UiOptionValues & {
	uv?: string;
	rp?: string;
	userName?: string;
	displayName?: string;
	userHandle?: string;
	id?: string;
	key?: string;
	signCount?: string;
	withKeys?: boolean;
};

/** Enabling the provider can install an APK and rewrite credential settings: well past the 5 s other `ui` verbs get. */
const PASSKEY_TIMEOUT_MS = "120000";

const READ_ACTIONS: ReadonlySet<string> = new Set(["list", "status"]);

const SHORT_ID = 12;

/** `auto · uv match · 2 credentials`; `off` when the authenticator is not on. */
export function describePasskeys(state: Pick<PasskeyState, "enabled" | "mode" | "uv" | "credentials">): string {
	if (!state.enabled) return `off · ${state.credentials.length} credential${state.credentials.length === 1 ? "" : "s"}`;
	const n = state.credentials.length;
	return `${state.mode} · uv ${state.uv} · ${n} credential${n === 1 ? "" : "s"}`;
}

function credentialLines(state: PasskeyState): string[] {
	return state.credentials.map(
		(c) =>
			`  ${c.credentialId.slice(0, SHORT_ID)}${c.credentialId.length > SHORT_ID ? "…" : ""}  ${c.rpId}  ${c.userName}  signCount ${c.signCount}`
	);
}

function timing(state: PasskeyState): string[] {
	return state.appliesOnLaunch === true
		? ["  applies when the app next launches (`warden ui open <bundle> --relaunch`): it was started without passkeys"]
		: [];
}

function view(
	device: UiDevice,
	action: string,
	state: PasskeyState,
	extra: Record<string, unknown> = {},
	head?: string
): Result<UiSuccess, UiError> {
	const text = [head, `passkeys  ${describePasskeys(state)}`, ...credentialLines(state), ...timing(state)]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	return success(device, action, text, {
		enabled: state.enabled,
		mode: state.mode,
		uv: state.uv,
		credentials: state.credentials,
		...(state.appliesOnLaunch === undefined ? {} : { appliesOnLaunch: state.appliesOnLaunch }),
		...extra,
	});
}

/** Records what the driver left on the lease (keeping an earlier `previousProvider`), or forgets it once the authenticator is off. */
function record(ctx: CommandContext, device: UiDevice, state: PasskeyState): Result<undefined, UiError> {
	const existing = recordOf(ctx, device.lease.id, "passkeys")?.value;
	if (!state.enabled) {
		if (existing !== undefined) forget(ctx, device, "passkeys");
		return { success: true, data: undefined };
	}
	const previousProvider = state.previousProvider ?? existing?.previousProvider;
	const value: PasskeyCondition = {
		mode: state.mode,
		uv: state.uv,
		...(previousProvider === undefined ? {} : { previousProvider }),
	};
	return save(ctx, device, "passkeys", value);
}

function parseSignCount(raw: string | undefined): Result<number | undefined, UiError> {
	if (raw === undefined) return { success: true, data: undefined };
	if (!/^\d+$/.test(raw)) return fail("usage", `--sign-count must be a non-negative integer, got "${raw}"`);
	return { success: true, data: Number(raw) };
}

/** A key file as the store takes it: PEM text, or DER bytes as base64url. */
function readKeyFile(ctx: CommandContext, path: string): Result<string, UiError> {
	try {
		const bytes = readFileSync(resolve(ctx.cwd, path));
		const text = bytes.toString("utf8");
		return { success: true, data: text.includes("-----BEGIN") ? text : bytes.toString("base64url") };
	} catch (error) {
		return fail("usage", `cannot read --key ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function buildCredential(ctx: CommandContext, opts: PasskeyOptionValues) {
	if (opts.rp === undefined || opts.rp === "") return fail("usage", "passkey add needs --rp <relying party id>");
	if (opts.userName === undefined || opts.userName === "") return fail("usage", "passkey add needs --user-name <name>");
	const signCount = parseSignCount(opts.signCount);
	if (!signCount.success) return signCount;
	let privateKey: string | undefined;
	if (opts.key !== undefined) {
		const key = readKeyFile(ctx, opts.key);
		if (!key.success) return key;
		privateKey = key.data;
	}
	const input: PasskeyInput = {
		rpId: opts.rp,
		userName: opts.userName,
		...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
		...(opts.userHandle === undefined ? {} : { userHandle: opts.userHandle }),
		...(opts.id === undefined ? {} : { credentialId: opts.id }),
		...(privateKey === undefined ? {} : { privateKey }),
		...(signCount.data === undefined ? {} : { signCount: signCount.data }),
	};
	const credential = createPasskeyCredential(input, { now: ctx.now });
	return credential.success ? credential : fail("usage", credential.error);
}

type Plan = { op: PasskeyOp; action: string; head?: (state: PasskeyState) => string };

const planned = (op: PasskeyOp, action: string, head?: Plan["head"]): Result<Plan, UiError> => ({
	success: true,
	data: { op, action, ...(head ? { head } : {}) },
});

function planSet(arg: string | undefined, opts: PasskeyOptionValues): Result<Plan, UiError> {
	if (arg === undefined || !isPasskeyMode(arg)) {
		return fail("usage", `passkey set needs a mode, got "${arg ?? ""}"`, PASSKEY_MODES.join(", "));
	}
	if (opts.uv === undefined) return planned({ kind: "set", mode: arg }, "passkey-set");
	if (!isPasskeyUv(opts.uv)) return fail("usage", `unknown --uv "${opts.uv}"`, PASSKEY_UV.join(", "));
	return planned({ kind: "set", mode: arg, uv: opts.uv }, "passkey-set");
}

function planAdd(ctx: CommandContext, opts: PasskeyOptionValues): Result<Plan, UiError> {
	const credential = buildCredential(ctx, opts);
	if (!credential.success) return credential;
	const { credentialId, rpId, userName } = credential.data;
	return planned(
		{ kind: "add", credential: credential.data },
		"passkey-add",
		() => `added passkey ${credentialId} (${rpId}, ${userName})`
	);
}

function planList(opts: PasskeyOptionValues): Result<Plan, UiError> {
	return planned(
		{
			kind: "list",
			...(opts.rp === undefined ? {} : { rpId: opts.rp }),
			...(opts.withKeys === true ? { withKeys: true } : {}),
		},
		"passkey-list"
	);
}

function plan(
	ctx: CommandContext,
	action: string,
	arg: string | undefined,
	opts: PasskeyOptionValues
): Result<Plan, UiError> {
	switch (action) {
		case "set":
			return planSet(arg, opts);
		case "add":
			return planAdd(ctx, opts);
		case "remove":
			if (arg === undefined || arg === "") return fail("usage", "passkey remove needs a credential id");
			return planned({ kind: "remove", credentialId: arg }, "passkey-remove");
		case "clear":
			return planned({ kind: "clear" }, "passkey-clear");
		case "list":
			return planList(opts);
		case "status":
			return planned({ kind: "status" }, "passkey-status");
		default:
			return fail("usage", `unknown passkey action "${action}"`, "set, off, add, list, remove, clear or status");
	}
}

/**
 * `warden ui passkey set <mode> [--uv …] | off | add | list | remove | clear | status`: the simulated passkey
 * authenticator the app's real WebAuthn calls reach. Credentials live in warden's per-device store, the mode and uv on
 * the lease's `passkeys` condition (shared with `device.passkeys` in specs); `warden release` undoes it.
 */
export function uiPasskey(
	ctx: CommandContext,
	deps: UiDeps,
	action: string,
	arg: string | undefined,
	opts: PasskeyOptionValues
): Promise<number> {
	const timed =
		opts.timeout === undefined && !READ_ACTIONS.has(action) ? { ...opts, timeout: PASSKEY_TIMEOUT_MS } : opts;
	return runUi(ctx, deps, `passkey ${action}`, timed, async (device) => {
		if (action === "off") {
			if (recordOf(ctx, device.lease.id, "passkeys") === undefined) {
				return success(device, "passkey-off", "passkeys were not on", { changed: false, enabled: false });
			}
			return withPort<UiSuccess>(ctx, await resolveDeps(deps), device, async (port) => {
				const done = fromDriver(await port.passkeys({ kind: "off" }));
				if (!done.success) return done;
				forget(ctx, device, "passkeys");
				return view(device, "passkey-off", done.data, { changed: true });
			});
		}
		const next = plan(ctx, action, arg, opts);
		if (!next.success) return next;
		const { op, action: name, head } = next.data;
		return withPort<UiSuccess>(ctx, await resolveDeps(deps), device, async (port) => {
			const done = fromDriver(await port.passkeys(op));
			if (!done.success) return done;
			if (!READ_ACTIONS.has(action)) {
				const saved = record(ctx, device, done.data);
				if (!saved.success) return saved;
			}
			const extra = op.kind === "add" ? { credentialId: op.credential.credentialId } : {};
			return view(device, name, done.data, extra, head?.(done.data));
		});
	});
}
