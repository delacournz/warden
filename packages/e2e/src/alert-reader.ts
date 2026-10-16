import type { Result } from "@delacour/warden-types/result";
import { type AlertBackend, canReadAlertOn } from "./driver/alerts";
import type { AlertInfo, Driver, DriverError } from "./driver/driver.types";
import { settled, toE2eError } from "./driver/unwrap";
import type { Clock } from "./fixture-session";

/**
 * A read that fails with a retryable error (the AX bridge names no frontmost application for a moment after a launch
 * or sheet change) is repeated every 100 ms for up to ~1.2 s: the gap after `app.open` is the length of that moment,
 * not a fixed 300 ms step.
 */
const ALERT_READ_ATTEMPTS = 13;
const ALERT_READ_RETRY_MS = 100;
/** A modal is up but its buttons are not readable yet: look again this many times, this far apart. */
export const ALERT_MODAL_LOOKS = 3;
const ALERT_MODAL_RETRY_MS = 200;

export type AlertReaderDeps = {
	driver: Driver;
	clock: Clock;
	/** the running attempt's deadline, read per call */
	signal: () => AbortSignal | undefined;
};

/** `readAlert(backend?, modalLooks?)`: see {@link createAlertReader}. */
export type AlertReader = (backend?: AlertBackend, modalLooks?: number) => Promise<AlertInfo | null>;

/**
 * Reads the system alert on top for `device.alert` and `device.openLink`.
 *
 * With `backend`, and a driver that can read one reader (`driver/alerts.ts`), that reader is read ONCE: a screen without
 * an alert costs one tree read where `driver.alert()` reads both readers, and nothing sleeps. A modal that is up but
 * shows no buttons yet (`buttons: []`) is looked at again `modalLooks` times, `ALERT_MODAL_RETRY_MS` apart, then reported
 * as it is. If that read fails, or there is no `backend`, the two-reader `driver.alert()` answers instead, retrying a
 * transient failure (the AX bridge briefly names no frontmost application right after a launch or sheet change) after a
 * short sleep.
 */
export function createAlertReader({ driver, clock, signal }: AlertReaderDeps): AlertReader {
	const read = (backend?: AlertBackend) =>
		settled(
			() => (backend !== undefined && canReadAlertOn(driver) ? driver.alertOn(backend) : driver.alert()),
			"read alert",
			signal()
		);

	const readOne = async (backend: AlertBackend, modalLooks: number): Promise<Result<AlertInfo | null, DriverError>> => {
		for (let looked = 0; ; looked += 1) {
			const result = await read(backend);
			if (!result.success) return result;
			const info = result.data;
			if (info === null || info.buttons.length > 0 || looked >= modalLooks) return result;
			await clock.sleep(ALERT_MODAL_RETRY_MS);
		}
	};

	const readBoth = async (): Promise<AlertInfo | null> => {
		for (let failures = 1; ; failures += 1) {
			const result = await read();
			if (result.success) return result.data;
			if (!result.error.retryable || failures >= ALERT_READ_ATTEMPTS) throw toE2eError(result.error, "read alert");
			await clock.sleep(ALERT_READ_RETRY_MS);
		}
	};

	return async (backend, modalLooks = ALERT_MODAL_LOOKS) => {
		if (backend !== undefined && canReadAlertOn(driver)) {
			const one = await readOne(backend, modalLooks);
			if (one.success) return one.data;
		}
		return readBoth();
	};
}
