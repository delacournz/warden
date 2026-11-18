import { dirname, join } from "node:path";
import type { DriverResult } from "../driver.types";
import { driverErr } from "../errors";
import type { KeychainAclOp, KeychainAclState } from "../keychain-acl";
import type { InjectChannel, InjectFs, InjectKeychainAcl } from "./inject";

/** Beside the state file: the enrolment generation, durable (the state file is deleted at every launch). */
export const KEYCHAIN_ACL_GENERATION_FILE = "keychain-acl.json";
/** Beside the state file: the generation each access-controlled item was written at. The dylib is its only writer. */
export const KEYCHAIN_ACL_ITEMS_FILE = "keychain-acl-items.json";

/**
 * The iOS host side of the Keychain ACL shim (WDN-KACL). The switch lives in the inject state file (`keychainAcl`
 * key; sticky for the lease: release's neutral state drops it), so a later driver on the lease (another `warden ui`
 * call, a relaunch) keeps it. The enrolment generation lives in its own host file next to it, with the same lifetime
 * as the dylib's item sidecar: both describe the simulator's Keychain, not one launch.
 */
export type IosKeychainAcl = {
	/** the shim is on: launches carry the dylib with `WARDEN_KEYCHAIN_ACL=1` */
	on(): boolean;
	/** the `keychainAcl` key of the next state write; undefined until it was ever switched on */
	state(): InjectKeychainAcl | undefined;
	run(op: KeychainAclOp, writeState: () => { seq: number }): DriverResult<KeychainAclState>;
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
	};
}
