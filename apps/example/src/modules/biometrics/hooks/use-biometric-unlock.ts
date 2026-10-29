import { authenticateAsync, hasHardwareAsync, isEnrolledAsync } from "expo-local-authentication";
import { useCallback, useEffect, useState } from "react";

/** What the screen shows; the strings are the values the specs assert on. */
export type BiometricStatus = "Checking" | "Not enrolled" | "Ready" | "Unlocked" | "Failed" | "Cancelled";

/** Auth errors that mean the prompt was dismissed rather than rejected. */
const CANCEL_ERRORS = new Set(["user_cancel", "system_cancel", "app_cancel"]);

/**
 * Biometric unlock state over `expo-local-authentication`. Enrollment is read on mount and again after every
 * attempt's end state is shown, so an `Unlocked` / `Failed` status is never confused with the enrollment read.
 * `disableDeviceFallback` keeps the passcode / PIN out of the prompt, so a rejected biometric surfaces as `Failed`.
 */
export function useBiometricUnlock(): { status: BiometricStatus; error: string; unlock: () => Promise<void> } {
	const [status, setStatus] = useState<BiometricStatus>("Checking");
	const [error, setError] = useState("none");

	useEffect(() => {
		let active = true;
		const read = async () => {
			const [hardware, enrolled] = await Promise.all([hasHardwareAsync(), isEnrolledAsync()]);
			if (active) setStatus(hardware && enrolled ? "Ready" : "Not enrolled");
		};
		read();
		return () => {
			active = false;
		};
	}, []);

	const unlock = useCallback(async () => {
		const enrolled = await isEnrolledAsync();
		if (!enrolled) {
			setStatus("Not enrolled");
			return;
		}
		const result = await authenticateAsync({
			promptMessage: "Unlock the example app",
			cancelLabel: "Cancel",
			disableDeviceFallback: true,
		});
		if (result.success) {
			setError("none");
			setStatus("Unlocked");
			return;
		}
		setError(result.error);
		setStatus(CANCEL_ERRORS.has(result.error) ? "Cancelled" : "Failed");
	}, []);

	return { status, error, unlock };
}
