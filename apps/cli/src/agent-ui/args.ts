import { DEFAULT_SETTLE_TIMEOUT_MS } from "@delacour/warden-driver/settle";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type UiError, uiOutput } from "./output";
import type { UiOptionValues } from "./run";

/** Options of every action that can wait for the screen to settle afterwards. */
export type ActionOptionValues = UiOptionValues & {
	/** `--settle` alone = true, `--settle 5000` = "5000" */
	settle?: true | string;
};

export class UiArgs {
	/** A positive integer flag value (`--depth 3`), else a usage error naming the flag. */
	positiveInt(name: string, raw: string): Result<number, UiError> {
		if (!/^\d+$/.test(raw) || Number(raw) < 1) {
			return { success: false, error: uiOutput.uiError("usage", `${name} must be a positive integer, got "${raw}"`) };
		}
		return resultFactory.ok(Number(raw));
	}

	/** `--settle [ms]` → the budget, or undefined when not asked for. */
	parseSettle(raw: true | string | undefined): Result<number | undefined, UiError> {
		if (raw === undefined) return resultFactory.ok(undefined);
		if (raw === true) return resultFactory.ok(DEFAULT_SETTLE_TIMEOUT_MS);
		return this.positiveInt("--settle", raw);
	}
}

export const uiArgs = new UiArgs();
