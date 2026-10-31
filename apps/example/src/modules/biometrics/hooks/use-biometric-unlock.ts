import { authenticateAsync, hasHardwareAsync, isEnrolledAsync } from "expo-local-authentication";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

/** What the screen shows; the strings are the values the specs assert on. */
export type BiometricStatus = "Checking" | "Not enrolled" | "Ready" | "Scanning" | "Unlocked" | "Failed" | "Cancelled";

/** One line of the attempt log; `at` is milliseconds since the screen mounted. */
export type BiometricEvent =
	| { kind: "requested"; at: number }
	| { kind: "unlocked"; at: number; tookMs: number }
	| { kind: "cancelled"; at: number; error: string }
	| { kind: "failed"; at: number; error: string }
	| { kind: "not-enrolled"; at: number }
	| { kind: "locked"; at: number };

/** Auth errors that mean the prompt was dismissed rather than rejected. */
const CANCEL_ERRORS = new Set(["user_cancel", "system_cancel", "app_cancel"]);

/** Statuses a fresh enrollment read may replace; never mid-scan and never over an outcome the user is looking at. */
const REREADABLE: ReadonlySet<BiometricStatus> = new Set(["Checking", "Ready", "Not enrolled"]);

/** The log keeps the latest few attempts; the screen has room for no more. */
const MAX_EVENTS = 4;

/**
 * Biometric unlock state over `expo-local-authentication`. Enrollment is read when the screen gains focus and when the
 * app returns to the foreground (only while `Checking` / `Ready` / `Not enrolled`, so never mid-scan or over an
 * outcome), and again before every attempt, so an `Unlocked` / `Failed` status is never confused with the enrollment
 * read. `Scanning` holds while the system prompt is up. `disableDeviceFallback` keeps the passcode / PIN out of the
 * prompt, so a rejected biometric surfaces as `Failed`. `lock` puts an unlocked vault back to `Ready`.
 */
export function useBiometricUnlock(): {
	status: BiometricStatus;
	error: string;
	events: readonly BiometricEvent[];
	unlock: () => Promise<void>;
	lock: () => void;
} {
	const [status, setStatus] = useState<BiometricStatus>("Checking");
	const [error, setError] = useState("none");
	const [events, setEvents] = useState<readonly BiometricEvent[]>([]);
	const mountedAt = useRef(Date.now());

	const log = useCallback((event: BiometricEvent) => {
		setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
	}, []);
	const since = useCallback(() => Date.now() - mountedAt.current, []);

	const refresh = useCallback(async () => {
		const [hardware, enrolled] = await Promise.all([hasHardwareAsync(), isEnrolledAsync()]);
		const next: BiometricStatus = hardware && enrolled ? "Ready" : "Not enrolled";
		setStatus((prev) => (REREADABLE.has(prev) ? next : prev));
	}, []);

	useFocusEffect(
		useCallback(() => {
			refresh();
		}, [refresh])
	);

	useEffect(() => {
		const sub = AppState.addEventListener("change", (state) => {
			if (state === "active") refresh();
		});
		return () => sub.remove();
	}, [refresh]);

	const unlock = useCallback(async () => {
		const enrolled = await isEnrolledAsync();
		if (!enrolled) {
			setStatus("Not enrolled");
			log({ kind: "not-enrolled", at: since() });
			return;
		}
		const startedAt = since();
		setStatus("Scanning");
		log({ kind: "requested", at: startedAt });
		const result = await authenticateAsync({
			promptMessage: "Unlock the vault",
			cancelLabel: "Cancel",
			disableDeviceFallback: true,
		});
		const at = since();
		if (result.success) {
			setError("none");
			setStatus("Unlocked");
			log({ kind: "unlocked", at, tookMs: at - startedAt });
			return;
		}
		setError(result.error);
		const cancelled = CANCEL_ERRORS.has(result.error);
		setStatus(cancelled ? "Cancelled" : "Failed");
		log(cancelled ? { kind: "cancelled", at, error: result.error } : { kind: "failed", at, error: result.error });
	}, [log, since]);

	const lock = useCallback(() => {
		setStatus("Ready");
		setError("none");
		log({ kind: "locked", at: since() });
	}, [log, since]);

	return { status, error, events, unlock, lock };
}
