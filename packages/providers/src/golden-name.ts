/**
 * Leaf: what a golden simulator is called. Split out of `golden/golden.ts` so `providers/ios.ts` and
 * `sims/rules.ts` can recognise goldens without importing the golden cluster.
 */
export const GOLDEN_PREFIX = "warden-golden";

/** Recognises golden simulator names. */
export class GoldenNames {
	isGolden(name: string): boolean {
		return name.startsWith(`${GOLDEN_PREFIX}-`);
	}
}

export const goldenNames = new GoldenNames();
