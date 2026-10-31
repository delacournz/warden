import type { ApiError } from "./api.types";

/** The `--json` error codes warden cloud billing adds to `usage` / `failed`. */
export type CloudErrorCode = "credits_exhausted" | "machine_required_for_trial" | "billing_role";

/** A warden-api failure as the CLI reports it: the line to print, plus a JSON code (and link) when it has one. */
export type CloudFailure = { message: string; code?: CloudErrorCode; billingUrl?: string };

const TOP_UP = "warden billing --top-up";

export function cloudFailure(error: ApiError): CloudFailure {
	if (error.kind === "payment_required") {
		const where = error.billingUrl ? `at ${error.billingUrl}` : `with: ${TOP_UP}`;
		return {
			code: "credits_exhausted",
			message: `remote claim failed: out of credits; top up ${where}`,
			...(error.billingUrl ? { billingUrl: error.billingUrl } : {}),
		};
	}
	if (error.kind === "forbidden" && error.code === "MACHINE_REQUIRED_FOR_TRIAL") {
		return {
			code: "machine_required_for_trial",
			message:
				"your free trial credit unlocks on the first claim from a machine you ran warden login on (not CI); " +
				`run warden login on your own machine and claim again, or top up with: ${TOP_UP}`,
		};
	}
	if (error.kind === "forbidden" && error.code === "BILLING_ROLE") {
		return {
			code: "billing_role",
			message: "only an organization owner or admin can top up; ask one to run warden billing --top-up",
		};
	}
	if (error.kind === "unauthorized") return { message: `${error.message} (session expired? run warden login)` };
	return { message: error.message };
}
