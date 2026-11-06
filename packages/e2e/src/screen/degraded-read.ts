import type { Snapshot, SnapshotBackend } from "../driver/driver.types";
import { E2eError } from "../errors";

/**
 * Why a snapshot cannot say a node is absent: it was answered by a fallback reader (`Snapshot.fellBackFrom`, iOS `ax`
 * after `axbridge` stalled, which drops React Native testIDs on static text), or it is one childless root with no
 * area (the reader could not see into the app). A match found on such a snapshot is real; a missing one is unknown.
 */
export type DegradedRead =
	| { kind: "fallback"; from: SnapshotBackend; backend: SnapshotBackend }
	| { kind: "emptyRoot"; backend: SnapshotBackend };

/** What makes `snapshot` inconclusive about absence; undefined for a whole read. */
export function degradedRead(snapshot: Snapshot): DegradedRead | undefined {
	if (snapshot.fellBackFrom !== undefined) {
		return { kind: "fallback", from: snapshot.fellBackFrom, backend: snapshot.backend };
	}
	const [root, ...others] = snapshot.elements;
	if (root !== undefined && others.length === 0 && root.children.length === 0) {
		const { width, height } = root.frame;
		if (width * height === 0) return { kind: "emptyRoot", backend: snapshot.backend };
	}
	return undefined;
}

/** One phrase naming what was degraded, with the fallback and read backend. */
export function describeDegraded(read: DegradedRead): string {
	if (read.kind === "emptyRoot") return `the ${read.backend} read returned an empty root (backend: ${read.backend})`;
	return `the read fell back from ${read.from} to ${read.backend} (fellBackFrom: ${read.from}, backend: ${read.backend}), which can drop React Native testIDs`;
}

/** Why the React tree did not settle it. */
export type ReactNote = "unanswered" | "no-devtools" | "not-testid";

const REACT_NOTES: Record<ReactNote, string> = {
	unanswered: "the React tree did not answer",
	"no-devtools": "there is no React tree to ask (no devtools: not a dev client with Metro)",
	"not-testid": "only a plain getByTestId can be asked of the React tree",
};

/** `READ_DEGRADED`: the bridge is degraded and `locator` could be confirmed neither present nor absent in `waitedMs`. */
export function degradedFailure(
	locator: string,
	read: DegradedRead,
	waitedMs: number,
	react: ReactNote,
	screen?: string
): E2eError {
	const message =
		`${locator} could not be confirmed within ${waitedMs} ms: bridge degraded, ${describeDegraded(read)}, ` +
		`and ${REACT_NOTES[react]}. A missing node on such a read is not proof of absence.`;
	return new E2eError("READ_DEGRADED", message, screen);
}
