import { type AlertBackend, alertCapabilities } from "@delacour/warden-driver/alerts";
import type { AlertInfo, Driver, DriverError } from "@delacour/warden-driver/driver.types";
import { driverCalls } from "@delacour/warden-driver/unwrap";
import type { Result } from "@delacour/warden-types/result";
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

/** `readAlert(backend?, modalLooks?)`: see {@link DeviceAlertReader}. */
export type AlertReader = (backend?: AlertBackend, modalLooks?: number) => Promise<AlertInfo | null>;

/**
 * Reads the system alert on top for `device.alert` and `device.openLink`.
 *
 * With `backend`, and a driver that can read one reader (`driver/alerts.ts`), that reader is read ONCE: a screen without
 * an alert costs one tree read where `driver.alert()` reads both readers, and nothing sleeps. A modal that is up but
 * shows no buttons yet (`buttons: []`) is looked at again `modalLooks` times, `ALERT_MODAL_RETRY_MS` apart, then reported
 * as it is. If the bridge read fails (it answers nothing for ~0.2 s after a launch, while its quiescence stream is not
 * bound to the new process), the host reader is read once: what `driver.alert()` would answer when one of its two readers
 * fails, for one read instead of two. If that fails too, or there is no `backend`, the two-reader `driver.alert()`
 * answers instead, retrying a transient failure after a short sleep.
 */
export class DeviceAlertReader {
	constructor(private readonly deps: AlertReaderDeps) {}

	/** The reader as a callable: `readAlert(backend?, modalLooks?)`. */
	readonly read: AlertReader = async (backend, modalLooks = ALERT_MODAL_LOOKS) => {
		if (backend !== undefined && alertCapabilities.canReadAlertOn(this.deps.driver)) {
			const one = await this.readOne(backend, modalLooks);
			if (one.success) return one.data;
			// the bridge answers nothing for ~0.2 s after a launch: ask the host reader once rather than the bridge again
			if (backend === "axbridge") {
				const host = await this.readOne("ax", 0);
				if (host.success) return host.data;
			}
		}
		return this.readBoth();
	};

	private readFrom(backend?: AlertBackend) {
		const { driver, signal } = this.deps;
		return driverCalls.settled(
			() =>
				backend !== undefined && alertCapabilities.canReadAlertOn(driver) ? driver.alertOn(backend) : driver.alert(),
			"read alert",
			signal()
		);
	}

	private async readOne(backend: AlertBackend, modalLooks: number): Promise<Result<AlertInfo | null, DriverError>> {
		for (let looked = 0; ; looked += 1) {
			const result = await this.readFrom(backend);
			if (!result.success) return result;
			const info = result.data;
			if (info === null || info.buttons.length > 0 || looked >= modalLooks) return result;
			await this.deps.clock.sleep(ALERT_MODAL_RETRY_MS);
		}
	}

	private async readBoth(): Promise<AlertInfo | null> {
		for (let failures = 1; ; failures += 1) {
			const result = await this.readFrom();
			if (result.success) return result.data;
			if (!result.error.retryable || failures >= ALERT_READ_ATTEMPTS)
				throw driverCalls.toE2eError(result.error, "read alert");
			await this.deps.clock.sleep(ALERT_READ_RETRY_MS);
		}
	}
}
