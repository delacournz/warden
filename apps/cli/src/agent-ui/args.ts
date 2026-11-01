import { DEFAULT_SETTLE_TIMEOUT_MS } from "@delacour/warden-driver/settle";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "./output";
import type { UiOptionValues } from "./run";

/** Options of every action that can wait for the screen to settle afterwards. */
export type ActionOptionValues = UiOptionValues & {
	/** `--settle` alone = true, `--settle 5000` = "5000" */
	settle?: true | string;
};

/** A positive integer flag value (`--depth 3`), else a usage error naming the flag. */
export function positiveInt(name: string, raw: string): Result<number, UiError> {
	if (!/^\d+$/.test(raw) || Number(raw) < 1) {
		return { success: false, error: uiError("usage", `${name} must be a positive integer, got "${raw}"`) };
	}
	return ok(Number(raw));
}

/** `--settle [ms]` → the budget, or undefined when not asked for. */
export function parseSettle(raw: true | string | undefined): Result<number | undefined, UiError> {
	if (raw === undefined) return ok(undefined);
	if (raw === true) return ok(DEFAULT_SETTLE_TIMEOUT_MS);
	return positiveInt("--settle", raw);
}
