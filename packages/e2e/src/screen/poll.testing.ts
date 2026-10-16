import type { Clock } from "./poll";

export type FakeClock = Clock & {
	/** ms since creation; advanced only by `sleep` and `advance` */
	elapsed(): number;
	/** every requested sleep, in order */
	readonly sleeps: number[];
	advance(ms: number): void;
};

/** A clock that never waits: `sleep` just moves time forward, so polling tests run instantly and deterministically. */
export function fakeClock(start = 0): FakeClock {
	let time = start;
	const sleeps: number[] = [];
	return {
		now: () => time,
		async sleep(ms) {
			sleeps.push(ms);
			time += ms;
		},
		elapsed: () => time - start,
		sleeps,
		advance(ms) {
			time += ms;
		},
	};
}
