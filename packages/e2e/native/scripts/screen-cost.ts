/**
 * CPU cost of the screen layer's per-poll work, over the golden snapshots and a synthetic React Native tree.
 * No device: every snapshot is data. Run it before and after a change to the locator / index / poll code:
 *
 *   bun native/scripts/screen-cost.ts [iterations=400] [rounds=5]
 *
 * Columns (microseconds per call, median of the rounds):
 *   index    `indexSnapshot` alone
 *   excerpt  `Runtime.excerpt`, the failure text (re-indexes, renders up to 40 lines)
 *   read     `locator.isVisible()` end to end on a fake driver: snapshot, index, resolve, strict one-match
 *   polls    attempts a 10 s wait makes on a fake clock that never finds its target (the device-read count)
 */
import { fakeDriver } from "../../src/driver/driver.testing";
import { Runtime } from "../../src/screen/context";
import { allFixtureSnapshots, type NamedSnapshot } from "../../src/screen/fixtures.testing";
import { indexSnapshot } from "../../src/screen/nodes";
import { poll } from "../../src/screen/poll";
import { fakeClock } from "../../src/screen/poll.testing";
import { createScreen } from "../../src/screen/screen";
import { testHost } from "../../src/screen/screen.testing";

const iterations = Number(process.argv[2] ?? 400);
const rounds = Number(process.argv[3] ?? 5);

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Microseconds per call of `run`, after a warm-up. */
async function measure(run: () => unknown | Promise<unknown>): Promise<number> {
	for (let i = 0; i < Math.min(50, iterations); i += 1) await run();
	const perRound: number[] = [];
	for (let round = 0; round < rounds; round += 1) {
		const started = performance.now();
		for (let i = 0; i < iterations; i += 1) await run();
		perRound.push(((performance.now() - started) * 1000) / iterations);
	}
	return median(perRound);
}

/** A test id that names exactly one element, to read through a real locator. */
function uniqueTestId({ snapshot }: NamedSnapshot): string | undefined {
	const counts = new Map<string, number>();
	for (const element of snapshot.flat) {
		if (element.identifier !== undefined && element.identifier !== "") {
			counts.set(element.identifier, (counts.get(element.identifier) ?? 0) + 1);
		}
	}
	return [...counts].find(([, count]) => count === 1)?.[0];
}

async function pollsInTenSeconds(): Promise<number> {
	const clock = fakeClock();
	const result = await poll(async () => ({ done: false, state: undefined }), { timeoutMs: 10_000, ...clock });
	return result.attempts;
}

function cell(value: number | undefined, width: number): string {
	return (value === undefined ? "-" : value.toFixed(1)).padStart(width);
}

const fixtures = allFixtureSnapshots();
console.log(`iterations ${iterations} x ${rounds} rounds; microseconds per call, median`);
console.log(
	`${"fixture".padEnd(36)}${"nodes".padStart(7)}${"index".padStart(10)}${"excerpt".padStart(10)}${"read".padStart(10)}`
);
for (const fixture of fixtures) {
	const { snapshot } = fixture;
	const driver = fakeDriver({ screens: [snapshot] });
	const host = testHost(driver);
	const runtime = new Runtime(host);
	const testId = uniqueTestId(fixture);
	const locator = testId === undefined ? undefined : createScreen(host).getByTestId(testId);
	const index = await measure(() => indexSnapshot(snapshot));
	const excerpt = await measure(() => runtime.excerpt(snapshot));
	const read = locator === undefined ? undefined : await measure(() => locator.isVisible());
	console.log(
		`${fixture.name.padEnd(36)}${String(snapshot.flat.length).padStart(7)}${cell(index, 10)}${cell(excerpt, 10)}${cell(read, 10)}`
	);
}
console.log(`polls in a 10 s wait: ${await pollsInTenSeconds()}`);
