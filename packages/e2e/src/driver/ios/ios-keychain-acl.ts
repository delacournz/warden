import { dirname, join } from "node:path";
import type { Result } from "@delacour/warden-types/result";
import type { DriverError, DriverResult } from "../driver.types";
import { driverErr } from "../errors";
import type { KeychainAclOp, KeychainAclState } from "../keychain-acl";
import { type InjectChannel, type InjectFs, type InjectKeychainAcl, injectLaunchEnv } from "./inject";
import { launchEnv } from "./simctl";

/** Beside the state file: the enrolment generation, durable (the state file is deleted at every launch). */
export const KEYCHAIN_ACL_GENERATION_FILE = "keychain-acl.json";
/** Beside the state file: the generation each access-controlled item was written at. The dylib is its only writer. */
export const KEYCHAIN_ACL_ITEMS_FILE = "keychain-acl-items.json";

/**
 * The iOS host side of the Keychain ACL shim (WDN-KACL). The switch lives in the inject state file (`keychainAcl`
 * key; sticky for the lease: every release of the lease switches it off), so a later driver on the lease (another `warden ui`
 * call, a relaunch) keeps it. The enrolment generation lives in its own host file next to it, with the same lifetime
 * as the dylib's item sidecar: both describe the simulator's Keychain, not one launch.
 */
export type IosKeychainAcl = {
	/** the shim is on: launches carry the dylib with `WARDEN_KEYCHAIN_ACL=1` */
	on(): boolean;
	/** the `keychainAcl` key of the next state write; undefined until it was ever switched on */
	state(): InjectKeychainAcl | undefined;
	run(op: KeychainAclOp, writeState: () => { seq: number }): DriverResult<KeychainAclState>;
	/**
	 * A biometric re-enrolment happened: with the shim on, the generation goes up by one (host file + state; a running
	 * injected app acknowledges it first, so a read right after sees it) and the new one is the answer; off = undefined.
	 */
	bump(writeState: () => { seq: number }): Promise<number | undefined>;
};

function readGeneration(fs: InjectFs, path: string): number | undefined {
	const text = fs.read(path);
	if (!text) return undefined;
	try {
		const data: unknown = JSON.parse(text);
		if (typeof data !== "object" || data === null || !("generation" in data)) return undefined;
		const { generation } = data;
		return typeof generation === "number" && Number.isInteger(generation) && generation >= 0 ? generation : undefined;
	} catch {
		return undefined;
	}
}

export function createIosKeychainAcl(deps: { channel: InjectChannel; fs: InjectFs; ackMs: number }): IosKeychainAcl {
	const { channel, fs } = deps;
	const dir = dirname(channel.statePath);
	const generationPath = join(dir, KEYCHAIN_ACL_GENERATION_FILE);
	const itemsPath = join(dir, KEYCHAIN_ACL_ITEMS_FILE);
	const saved = channel.current().keychainAcl;
	let enabled = saved?.enabled === true;
	/** ever sent: keep sending it (enabled false) so a running app turns its gate off */
	let sent = saved !== undefined;
	const generation = () => readGeneration(fs, generationPath) ?? saved?.generation ?? 0;
	const live = () => channel.attached()?.keychainAcl === true;
	const view = (staged: boolean): KeychainAclState => ({
		enabled,
		generation: generation(),
		...(staged && enabled ? { appliesOnLaunch: true as const } : {}),
	});

	return {
		on: () => enabled,
		state: () => (sent || enabled ? { enabled, generation: generation(), itemsPath } : undefined),
		async run(op, writeState) {
			if (op.kind === "status") return { success: true, data: view(!live()) };
			const before = { enabled, sent };
			enabled = op.kind === "on";
			sent = true;
			const written = writeState();
			if (!live()) return { success: true, data: view(true) };
			if (await channel.acked(written.seq, deps.ackMs)) return { success: true, data: view(false) };
			({ enabled, sent } = before);
			return driverErr(
				"E_TIMEOUT",
				`the injected app did not acknowledge the Keychain ACL shim within ${deps.ackMs} ms`,
				{
					detail: { pid: channel.attached()?.pid, statePath: channel.statePath },
				}
			);
		},
		async bump(writeState) {
			if (!enabled) return undefined;
			const next = generation() + 1;
			fs.mkdir(dir);
			fs.writeAtomic(generationPath, JSON.stringify({ generation: next }));
			const written = writeState();
			// a running app that misses the ack still picks the generation up from the state file on its next poll
			if (live()) await channel.acked(written.seq, deps.ackMs);
			return next;
		},
	};
}

/**
 * A launch that bypasses the driver (`warden dev`'s raw `simctl launch`): the shim's switch for the device is
 * `enabled`, else what its state file already says (`ui open --keychain-acl` earlier); it is written into the state
 * (the other keys kept), so the next driver on the lease sees it. On = the `SIMCTL_CHILD_*` env that loads the dylib
 * with the shim (pass it through the exec env, never argv); off or never switched = `{}`, a plain launch.
 */
export function rawLaunchKeychainAcl(o: {
	channel: InjectChannel;
	fs: InjectFs;
	enabled: boolean | undefined;
	dylib: () => Result<string, DriverError>;
}): Result<{ enabled: boolean; env: Record<string, string> }, DriverError> {
	const { channel, fs } = o;
	const { seq: _seq, ...current } = channel.current();
	if (o.enabled === undefined && current.keychainAcl === undefined)
		return { success: true, data: { enabled: false, env: {} } };
	const enabled = o.enabled ?? current.keychainAcl?.enabled === true;
	const dylib = enabled ? o.dylib() : undefined;
	if (dylib && !dylib.success) return dylib;
	const dir = dirname(channel.statePath);
	const generation =
		readGeneration(fs, join(dir, KEYCHAIN_ACL_GENERATION_FILE)) ?? current.keychainAcl?.generation ?? 0;
	channel.write({ ...current, keychainAcl: { enabled, generation, itemsPath: join(dir, KEYCHAIN_ACL_ITEMS_FILE) } });
	if (!dylib) return { success: true, data: { enabled: false, env: {} } };
	const env = launchEnv(injectLaunchEnv({ dylib: dylib.data, statePath: channel.statePath, keychainAcl: true }));
	return { success: true, data: { enabled: true, env } };
}
