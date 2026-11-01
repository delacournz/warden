import type { CommandContext } from "./context";
import type { Spinner } from "./ui";

export class SpinnerContext {
	/**
	 * Run `work` under a spinner; anything the work writes to `ctx.err` (progress notes such as
	 * "golden: building …") is printed above the spinner instead of garbling it.
	 */
	async withSpinner<T>(
		ctx: CommandContext,
		text: string,
		work: (ctx: CommandContext, spinner: Spinner) => Promise<T>
	): Promise<T> {
		const spinner = ctx.ui.spinner(text);
		try {
			return await work({ ...ctx, err: (line) => spinner.log(line) }, spinner);
		} finally {
			spinner.stop();
		}
	}
}

export const spinnerContext = new SpinnerContext();
