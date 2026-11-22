import {
	DEFAULT_PASSKEY_MODE,
	DEFAULT_PASSKEY_UV,
	type PasskeyCredential,
	type PasskeyMode,
	type PasskeyUv,
} from "@delacour/warden-core/conditions/conditions.types";
import {
	filterPasskeys,
	publicPasskey,
	readPasskeyStore,
	upsertPasskey,
	writePasskeyStore,
} from "@delacour/warden-core/conditions/passkey-store";
import type { DriverResult, PasskeyOp, PasskeyState } from "../driver.types";
import { driverErr } from "../errors";
import type { InjectChannel, InjectPasskeys } from "./inject";

/**
 * The iOS side of the virtual authenticator (WDN-PASS): mode and uv live in the inject state file (`passkeys` key,
 * answered by the dylib launched with `WARDEN_PASSKEYS=1`), credentials in the lease's store file, which the dylib
 * reads on every request and appends to when the app registers.
 */
export type IosPasskeys = {
	/** the authenticator is on: launches carry the dylib with `WARDEN_PASSKEYS=1` */
	on(): boolean;
	/** the `passkeys` key of the next state write; undefined when off */
	state(): InjectPasskeys | undefined;
	/** run `op`; `writeState` writes the whole inject state (called after `set` / `off`) */
	run(op: PasskeyOp, writeState: () => { seq: number }): DriverResult<PasskeyState>;
};

/** The store after `op` (`list` / `status` change nothing and return the same array). */
function edited(op: PasskeyOp, credentials: PasskeyCredential[]): PasskeyCredential[] {
	if (op.kind === "add") return upsertPasskey(credentials, op.credential);
	if (op.kind === "remove") return credentials.filter((c) => c.credentialId !== op.credentialId);
	return op.kind === "clear" ? [] : credentials;
}

export function createIosPasskeys(deps: { channel: InjectChannel; store?: string; ackMs: number }): IosPasskeys {
	if (deps.store === undefined) {
		return {
			on: () => false,
			state: () => undefined,
			run: async () =>
				driverErr("E_UNSUPPORTED", "this iOS network layer was opened without a passkey store (no lease directory)"),
		};
	}
	return storedPasskeys({ ...deps, store: deps.store });
}

function storedPasskeys(deps: { channel: InjectChannel; store: string; ackMs: number }): IosPasskeys {
	const { channel, store } = deps;
	const saved = channel.current().passkeys;
	let enabled = saved !== undefined;
	let mode: PasskeyMode = saved?.mode ?? DEFAULT_PASSKEY_MODE;
	let uv: PasskeyUv = saved?.uv ?? DEFAULT_PASSKEY_UV;
	const live = () => channel.attached()?.passkeys === true;

	const view = (op: PasskeyOp, credentials: readonly PasskeyCredential[], applies: boolean): PasskeyState => ({
		enabled,
		mode,
		uv,
		credentials: filterPasskeys(credentials, op.kind === "list" ? op.rpId : undefined).map((c) =>
			publicPasskey(c, op.kind === "list" && op.withKeys === true)
		),
		...(applies && enabled && !live() ? { appliesOnLaunch: true as const } : {}),
	});

	/** `set` / `off`: the state file, acked by an app that has the authenticator, else staged for the next launch. */
	async function switchState(
		op: PasskeyOp & { kind: "set" | "off" },
		writeState: () => { seq: number }
	): DriverResult<PasskeyState> {
		const before = { enabled, mode, uv };
		enabled = op.kind === "set";
		if (op.kind === "set") {
			mode = op.mode ?? mode;
			uv = op.uv ?? uv;
		}
		const written = writeState();
		const credentials = readPasskeyStore(store);
		const shown = credentials.success ? credentials.data : [];
		if (!live()) return { success: true, data: view(op, shown, true) };
		if (await channel.acked(written.seq, deps.ackMs)) return { success: true, data: view(op, shown, false) };
		({ enabled, mode, uv } = before);
		return driverErr("E_TIMEOUT", `the injected app did not acknowledge the passkeys within ${deps.ackMs} ms`, {
			detail: { pid: channel.attached()?.pid, statePath: channel.statePath },
		});
	}

	return {
		on: () => enabled,
		state: () => (enabled ? { mode, uv, storePath: store } : undefined),
		async run(op, writeState) {
			if (op.kind === "set" || op.kind === "off") return switchState(op, writeState);
			const stored = readPasskeyStore(store);
			if (!stored.success) return driverErr("E_PASSKEY_STORE", stored.error);
			const next = edited(op, stored.data);
			if (next !== stored.data) {
				const written = writePasskeyStore(store, next);
				if (!written.success) return driverErr("E_PASSKEY_STORE", written.error);
			}
			return { success: true, data: view(op, next, op.kind === "status") };
		},
	};
}
