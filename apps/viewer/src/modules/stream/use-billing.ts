import { listen } from "@tauri-apps/api/event";
import { useEffect, useReducer } from "react";
import { type BillingState, initialBilling, reduceBilling, type StopReason } from "./billing-state.ts";

type BillingEvent = { lowBalance: boolean };
type StoppedEvent = { reason: StopReason };

/** Folds the `viewer-billing` and `viewer-stopped` events from Rust into one state. */
export function useBilling(): BillingState {
	const [state, dispatch] = useReducer(reduceBilling, initialBilling);

	useEffect(() => {
		let disposed = false;
		const offs: Array<() => void> = [];
		const track = (pending: Promise<() => void>) =>
			pending.then((off) => {
				if (disposed) off();
				else offs.push(off);
			});
		void track(
			listen<BillingEvent>("viewer-billing", (e) => dispatch({ type: "billing", lowBalance: e.payload.lowBalance }))
		);
		void track(listen<StoppedEvent>("viewer-stopped", (e) => dispatch({ type: "stopped", reason: e.payload.reason })));
		return () => {
			disposed = true;
			for (const off of offs) off();
		};
	}, []);

	return state;
}
