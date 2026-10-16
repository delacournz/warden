import { ok } from "@delacour/warden-types/result";
import type { ConsoleLine, DevtoolsFacet, NetworkEntry, ReactTree, TreeOptions } from "./devtools.types";
import type { SelectedTarget } from "./inspector";

export type StubFacet = {
	facet: DevtoolsFacet;
	/** every expression given to `evaluate` */
	evaluated: string[];
	treeCalls: (TreeOptions | undefined)[];
	closes: () => number;
	/** directories `attachArtifacts` was asked to write into */
	artifactDirs: string[];
	/** what `console.lines()` reports; the test fills it */
	consoleLines: ConsoleLine[];
	networkEntries: NetworkEntry[];
	tree: ReactTree;
};

const TARGET: SelectedTarget = {
	wsUrl: "ws://127.0.0.1:8081/inspector/debug",
	deviceName: "iPhone A",
	appId: "com.example.app",
	logicalDeviceId: undefined,
	fusebox: true,
	id: "page-1",
	title: undefined,
};

/** A `DevtoolsFacet` that talks to nothing: calls are recorded, answers are the fields of the returned object. */
export function stubFacet(): StubFacet {
	let closes = 0;
	const stub: StubFacet = {
		evaluated: [],
		treeCalls: [],
		closes: () => closes,
		artifactDirs: [],
		consoleLines: [],
		networkEntries: [],
		tree: { components: [], truncated: false },
		facet: {
			async evaluate(expression) {
				stub.evaluated.push(expression);
				return ok(undefined);
			},
			async reloadJs() {
				return ok({ method: "expo" as const });
			},
			console: {
				lines: () => stub.consoleLines,
				clear: () => {
					stub.consoleLines = [];
				},
				mark: (label) => {
					stub.consoleLines.push({ ts: 0, level: "info", kind: "note", text: label });
				},
			},
			network: {
				entries: async () => stub.networkEntries,
				clear: async () => {
					stub.networkEntries = [];
				},
			},
			async tree(options) {
				stub.treeCalls.push(options);
				return ok(stub.tree);
			},
			target: TARGET,
			on: () => () => undefined,
			async attachArtifacts(dir) {
				stub.artifactDirs.push(dir);
				return ok({ console: `${dir}/console.jsonl`, network: `${dir}/network.jsonl` });
			},
			close() {
				closes += 1;
			},
		},
	};
	return stub;
}
