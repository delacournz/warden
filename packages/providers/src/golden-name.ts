/**
 * Leaf: what a golden simulator is called. Split out of `golden/golden.ts` so `providers/ios.ts` and
 * `sims/rules.ts` can recognise goldens without importing the golden cluster.
 */
export const GOLDEN_PREFIX = "warden-golden";

export function isGoldenName(name: string): boolean {
	return name.startsWith(`${GOLDEN_PREFIX}-`);
}
