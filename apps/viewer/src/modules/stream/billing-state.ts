export type StopReason = "user" | "idle" | "credits_exhausted" | "error" | "unknown";

export type BillingState = { lowBalance: boolean; stopped: StopReason | null };

export type BillingAction = { type: "billing"; lowBalance: boolean } | { type: "stopped"; reason: StopReason };

export type Overlay = "expired" | "out-of-credits" | "stopped";

export const initialBilling: BillingState = { lowBalance: false, stopped: null };

/** A stop is final: once the device is stopped no later event changes anything. */
export function reduceBilling(state: BillingState, action: BillingAction): BillingState {
	if (state.stopped) return state;
	if (action.type === "stopped") return { lowBalance: false, stopped: action.reason };
	return { ...state, lowBalance: action.lowBalance };
}

/** Which state replaces the stream, if any. Expired access takes precedence over a stop. */
export function overlayFor(expired: boolean, state: BillingState): Overlay | null {
	if (expired) return "expired";
	if (!state.stopped) return null;
	return state.stopped === "credits_exhausted" ? "out-of-credits" : "stopped";
}
