/** Where a run's `headless` can come from, highest precedence first. */
export type HeadlessInput = {
	/** `--headless` / `--no-headless` (undefined = not passed) */
	flag?: boolean | undefined;
	/** `e2e.<suite>.headless` / `batches.<name>.headless`, else the top-level `headless` */
	config?: boolean | undefined;
	env: Record<string, string | undefined>;
};

/** `WARDEN_HEADLESS=1` (or `true`) turns headless on when nothing above it decides. */
export function envHeadless(env: Record<string, string | undefined>): boolean {
	const value = env.WARDEN_HEADLESS?.trim().toLowerCase();
	return value === "1" || value === "true";
}

/** Precedence: CLI flag > config (suite / preset > top-level) > `WARDEN_HEADLESS` > off. */
export function resolveHeadless(input: HeadlessInput): boolean {
	return input.flag ?? input.config ?? envHeadless(input.env);
}
