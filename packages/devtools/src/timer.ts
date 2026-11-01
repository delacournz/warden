import type { Sleep } from "./devtools.types";

/** The real clock's sleep. Tests inject their own {@link Sleep}; production code falls back to {@link timer}. */
export class Timer {
	readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

export const timer = new Timer();
