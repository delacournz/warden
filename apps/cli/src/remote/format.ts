import type { Billing, TrialState } from "./api.types";

/** `$1.60`; negative amounts as `-$0.40`. */
export function usd(amount: number): string {
	return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toFixed(2)}`;
}

/** `~8 min left at $0.20/min`. */
export function minutesLeft(billing: Pick<Billing, "estMinutesLeft" | "ratePerMinuteUsd">): string {
	return `~${Math.floor(billing.estMinutesLeft)} min left at ${usd(billing.ratePerMinuteUsd)}/min`;
}

/** `active ($2.00)`, `held ($2.00, unlocks on your first claim)`, … */
export function trialLine(trial: { state: TrialState; amountUsd: number }): string {
	switch (trial.state) {
		case "active":
			return `active (${usd(trial.amountUsd)})`;
		case "held":
			return `held (${usd(trial.amountUsd)}, unlocks on your first claim from a machine you ran warden login on)`;
		case "revoked":
			return "revoked (this machine already had a trial)";
		case "none":
			return "none";
	}
}
