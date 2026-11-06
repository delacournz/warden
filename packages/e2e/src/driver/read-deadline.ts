import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The deadline of the wait a driver read is made for, so a read that itself waits for something (the cold iOS
 * bridge loop) stops when the caller's wait is over instead of running its own budget to the end inside it. The
 * screen layer's polls set it around every attempt; a read outside one has none. It carries a function, not an
 * instant, so the driver and the screen layer need not share a clock.
 */
type ReadDeadline = { remaining(): number };

const deadlines = new AsyncLocalStorage<ReadDeadline>();

/** Runs `fn` with `remaining` as the deadline of every read made inside it, awaits included. */
export function withReadDeadline<T>(remaining: () => number, fn: () => T): T {
	return deadlines.run({ remaining }, fn);
}

/** How long the innermost read deadline has left (never negative), or undefined outside one. */
export function readDeadlineRemaining(): number | undefined {
	const deadline = deadlines.getStore();
	return deadline === undefined ? undefined : Math.max(0, deadline.remaining());
}
