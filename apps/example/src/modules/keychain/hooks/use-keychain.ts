import { useCallback, useState } from "react";
import { type KeychainAcl, type KeychainRead, keychainAcl } from "../../../../modules/keychain-acl";
import { type KeychainStatus, readStatusOf, saveStatusOf } from "../utils/keychain-status";

/** The two demo items: the app's usual secret (Face ID, else the passcode) and one only the current face opens. */
export const KEYCHAIN_ITEMS = {
	gate: { account: "gate", acl: "currentSetOrPasscode" },
	bio: { account: "bio", acl: "currentSet" },
} as const satisfies Record<string, { account: string; acl: KeychainAcl }>;

export type KeychainItem = keyof typeof KEYCHAIN_ITEMS;

/** How a read asks: a plain read, one that may not show UI, or the plain read made on the main thread. */
export type ReadMode = "plain" | "no-ui" | "main";

const SECRET = "warden-secret";

/**
 * The Keychain screen's state over the local `KeychainAcl` module (iOS only; Android shows `Unavailable`). `code` is
 * the raw OSStatus of the last call (`none` before the first), `value` the secret a read returned (`none` otherwise).
 * A read is a plain `SecItemCopyMatching`: the app never calls `evaluatePolicy` itself, the Keychain's access control
 * is what asks for Face ID or the passcode.
 */
export function useKeychain(): {
	status: KeychainStatus;
	code: string;
	value: string;
	save: (item: KeychainItem) => Promise<void>;
	read: (item: KeychainItem, mode: ReadMode) => Promise<void>;
	remove: () => Promise<void>;
} {
	const [status, setStatus] = useState<KeychainStatus>(keychainAcl ? "Ready" : "Unavailable");
	const [code, setCode] = useState("none");
	const [value, setValue] = useState("none");

	const save = useCallback(async (item: KeychainItem) => {
		if (!keychainAcl) return;
		const { account, acl } = KEYCHAIN_ITEMS[item];
		const result = await keychainAcl.save(account, SECRET, acl);
		setCode(String(result));
		setValue("none");
		setStatus(saveStatusOf(result));
	}, []);

	const read = useCallback(async (item: KeychainItem, mode: ReadMode) => {
		if (!keychainAcl) return;
		const { account } = KEYCHAIN_ITEMS[item];
		setStatus("Reading");
		const result: KeychainRead =
			mode === "main" ? await keychainAcl.readOnMain(account) : await keychainAcl.read(account, mode === "no-ui");
		setCode(String(result.status));
		setValue(result.value ?? "none");
		setStatus(readStatusOf(result.status));
	}, []);

	const remove = useCallback(async () => {
		if (!keychainAcl) return;
		const results = await Promise.all(Object.values(KEYCHAIN_ITEMS).map(({ account }) => keychainAcl?.remove(account)));
		setCode(results.join(","));
		setValue("none");
		setStatus("Deleted");
	}, []);

	return { status, code, value, save, read, remove };
}
