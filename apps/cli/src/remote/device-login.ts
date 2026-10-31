import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { WardenApi } from "./api";
import type { DeviceCode } from "./api.types";

export type PollClock = { now: () => number; sleep: (ms: number) => Promise<void> };

/** RFC 8628 §3.5: a `slow_down` answer adds 5 seconds to the polling interval. */
const SLOW_DOWN_MS = 5000;

/**
 * Poll the device-token endpoint until the browser approves (→ the session token), denies, or the code expires.
 * The first poll waits one interval too: the user has only just been shown the code.
 */
export async function pollDeviceToken(
	api: Pick<WardenApi, "deviceToken">,
	code: DeviceCode,
	clock: PollClock
): AsyncResult<string> {
	const deadline = clock.now() + code.expiresIn * 1000;
	let interval = code.interval * 1000;
	while (clock.now() < deadline) {
		await clock.sleep(interval);
		const poll = await api.deviceToken(code.deviceCode);
		if (!poll.success) return err(poll.error.message);
		switch (poll.data.kind) {
			case "token":
				return ok(poll.data.token);
			case "denied":
				return err("login was denied in the browser");
			case "expired":
				return err("the login code expired; run warden login again");
			case "slow_down":
				interval += SLOW_DOWN_MS;
				break;
			case "pending":
				break;
		}
	}
	return err("the login code expired; run warden login again");
}
