import type { Screen } from "@delacour/warden-e2e";
import { ids } from "./ids";
import { pollUntil } from "./poll";

/** Longest a Fetch (two 8 s attempts plus the 3 s retry delay) can take in the app. */
export const FETCH_SETTLE_MS = 25_000;

/** Taps Fetch and waits until the request is no longer in flight; returns the final status ("success" / "error"). */
export async function fetchAndSettle(screen: Screen): Promise<string> {
	await screen.getByTestId(ids.conditions.fetch).tap();
	return pollUntil(
		() => screen.getByTestId(ids.conditions.fetchStatus).text(),
		(status) => status === "success" || status === "error",
		FETCH_SETTLE_MS
	);
}

/** Reads the `<label>: <value>` caption behind `testId` and returns the value. */
export async function readValue(screen: Screen, testId: string): Promise<string> {
	const text = await screen.getByTestId(testId).text();
	return text.slice(text.indexOf(":") + 1).trim();
}
