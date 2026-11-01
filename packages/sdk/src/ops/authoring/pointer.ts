/** Where a finished recording goes: a spec file, or an exported function in a helpers module. */
export type RecordingTarget =
	| { kind: "spec"; path: string }
	| { kind: "helper"; path: string; fn: string; prerequisite?: string };

/**
 * The recording in progress (`record start`). The steps live in the journal (`recordingFile`); this is where `record
 * stop` writes them. `wrote` is set once stop has written the target, so a second stop after a failed verify replaces
 * its own file instead of refusing it as foreign.
 */
export type RecordingPointer = {
	name: string;
	title?: string;
	target: RecordingTarget;
	/** ids module (`export const ids = { … } as const`) to merge test ids into */
	ids?: string;
	/** the `e2e.<name>` suite `record stop` verifies in */
	suite?: string;
	/** the shared `test.use` object to pass (module absolute); `"none"` = pass nothing. Absent = detect at stop */
	options?: { module: string; name: string } | "none";
	startedAt: number;
	/** `stop` may replace the target without being asked again */
	overwrite?: true;
	wrote?: true;
	/** route capture (dev client only): the route seen last, the one at `record start`, and consecutive failed reads (capture stops after a few) */
	routes?: { initial?: string; last?: string; misses?: number };
};
