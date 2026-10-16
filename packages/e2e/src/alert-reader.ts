import { type AlertBackend, canReadAlertOn } from "./driver/alerts";
import type { AlertInfo, Driver } from "./driver/driver.types";
import { settled, toE2eError } from "./driver/unwrap";
import type { Clock } from "./fixture-session";

const ALERT_READ_ATTEMPTS = 5;
const ALERT_READ_RETRY_MS = 300;

export type AlertReaderDeps = {
	driver: Driver;
	clock: Clock;
	/** the running attempt's deadline, read per call */
	signal: () => AbortSignal | undefined;
};

/** `readAlert(backend?)`: see {@link createAlertReader}. */
export type AlertReader = (backend?: AlertBackend) => Promise<AlertInfo | null>;

/**
 * Reads the system alert on top for `device.alert` and `device.openLink`.
 *
 * With `backend`, and a driver that can read one reader (`driver/alerts.ts`), that reader is read ONCE: a screen without
 * an alert costs one tree read where `driver.alert()` reads both readers, and nothing sleeps. If that read fails, or
 * there is no `backend`, the two-reader `driver.alert()` answers instead, retrying a transient failure (the AX bridge
 * briefly names no frontmost application right after a launch or sheet change) after a sleep.
 */
export function createAlertReader({ driver, clock, signal }: AlertReaderDeps): AlertReader {
	const read = (backend?: AlertBackend) =>
		settled(
			() => (backend !== undefined && canReadAlertOn(driver) ? driver.alertOn(backend) : driver.alert()),
			"read alert",
			signal()
		);

	const readBoth = async (): Promise<AlertInfo | null> => {
		for (let failures = 1; ; failures += 1) {
			const result = await read();
			if (result.success) return result.data;
			if (!result.error.retryable || failures >= ALERT_READ_ATTEMPTS) throw toE2eError(result.error, "read alert");
			await clock.sleep(ALERT_READ_RETRY_MS);
		}
	};

	return async (backend) => {
		if (backend !== undefined && canReadAlertOn(driver)) {
			const one = await read(backend);
			if (one.success) return one.data;
		}
		return readBoth();
	};
}
