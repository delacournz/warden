import type { Clock } from "./poll";

/**
 * A clock that never waits: `sleep` just moves time forward, so polling tests run instantly and deterministically.
 * `now` and `sleep` are arrow properties so they can be passed on detached, as `poll` does.
 */
export class FakeClock implements Clock {
	/** every requested sleep, in order */
	readonly sleeps: number[] = [];
	private time: number;

	constructor(private readonly start = 0) {
		this.time = start;
	}

	readonly now = (): number => this.time;

	readonly sleep = async (ms: number): Promise<void> => {
		this.sleeps.push(ms);
		this.time += ms;
	};

	/** ms since creation; advanced only by `sleep` and `advance` */
	elapsed(): number {
		return this.time - this.start;
	}

	advance(ms: number): void {
		this.time += ms;
	}
}
