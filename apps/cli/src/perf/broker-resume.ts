import type { CommandContext } from "../context";
import { resumeBroker } from "../dev-broker/profile-client";

const pendingResumes = new Set<Promise<boolean>>();

/** Wait for the `resume` calls `connectJs` sessions queued on close; a CLI that exits first would drop them. */
export async function settleBrokerResumes(): Promise<void> {
	await Promise.all([...pendingResumes]);
}

/**
 * A second Hermes socket on a single-debugger Metro closes the dev session's broker socket, which then waits for
 * `resume`. When a `warden dev` broker serves this device, closing the capture's socket asks it to take the page
 * back (a no-op when the broker kept its own socket). Callers that exit right after must `settleBrokerResumes`.
 */
export function resumeBrokerOnClose<S extends { close: () => void }>(ctx: CommandContext, udid: string, session: S): S {
	const close = session.close;
	return {
		...session,
		close: () => {
			close();
			const pending = resumeBroker(ctx.env, { udid }).finally(() => pendingResumes.delete(pending));
			pendingResumes.add(pending);
		},
	};
}
