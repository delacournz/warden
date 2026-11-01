import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import type { LeaseSelector } from "@delacour/warden-leasing/lease-select";

/** Values `withSelectOptions` parses to. */
export type SelectOptionValues = { udid?: string[]; mine?: boolean; session?: string; label?: string };

export class LeaseSelect {
	/** Selector options shared by `release` + `heartbeat`; the `[leaseIds...]` argument is the caller's. */
	withSelectOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
		cmd: Commander<Args, Opts, Globals>
	) {
		return cmd
			.option("--udid <udid...>", "select leases of these device udids / serials (repeatable)")
			.option("--mine", "select every lease held by this owner")
			.option("--label <label>", "with --mine: only leases whose label equals this")
			.option("--session <id>", "select every lease held by this agent session");
	}

	/** Lease-id arguments + `withSelectOptions` values → selector. */
	selectorFrom(ids: readonly string[], values: SelectOptionValues): LeaseSelector {
		return {
			ids: [...ids],
			udids: values.udid ?? [],
			mine: values.mine === true,
			...(values.session !== undefined ? { session: values.session } : {}),
			...(values.label !== undefined ? { label: values.label } : {}),
		};
	}
}

export const leaseSelect = new LeaseSelect();
