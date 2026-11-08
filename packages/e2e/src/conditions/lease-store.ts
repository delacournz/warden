import { defaultDbPath, openStore, type Store } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";

/** Opens the lease store; a failure is a `Result`, never a throw. */
export type StoreOpener = () => Result<Store>;

const shared = new Map<string, Store>();

/**
 * The spec process's one connection to the lease store, opened on first use: a run that sets no condition and
 * shapes no network never opens it. Connections are kept per db path for the life of the process.
 */
export function sharedStoreOpener(env: Readonly<Record<string, string | undefined>> = process.env): StoreOpener {
	return () => {
		const path = defaultDbPath({ ...env });
		const open = shared.get(path);
		if (open) return ok(open);
		try {
			const store = openStore(path);
			shared.set(path, store);
			return ok(store);
		} catch (error) {
			return err(`cannot open the warden store at ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}
