import type { SpawnViewer, ViewerProc } from "./viewer";

export type FakeViewer = {
	spawn: SpawnViewer;
	/** every spawn: argv, env and the options it was started with */
	spawns: Array<{ cmd: string[]; env: Record<string, string | undefined>; detached: boolean }>;
	/** lines written to the viewer's stdin, parsed */
	stdin: Array<Record<string, unknown>>;
	stdinClosed: () => boolean;
	killed: () => boolean;
	released: () => boolean;
	/** a line the viewer prints on stdout (replayed to a listener that attaches later) */
	say: (event: Record<string, unknown>) => void;
	/** the viewer window closes with `code` */
	exit: (code: number) => void;
};

/** A viewer process that records what it is sent and exits when told to. */
export function fakeViewer(pid = 4242): FakeViewer {
	const listeners: Array<(line: string) => void> = [];
	const said: string[] = [];
	let resolveExit: (code: number) => void = () => undefined;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const state = { closed: false, killed: false, released: false };
	const fake: FakeViewer = {
		spawns: [],
		stdin: [],
		stdinClosed: () => state.closed,
		killed: () => state.killed,
		released: () => state.released,
		say: (event) => {
			const line = JSON.stringify(event);
			said.push(line);
			for (const listener of listeners) listener(line);
		},
		exit: (code) => resolveExit(code),
		spawn: (cmd, env, opts) => {
			fake.spawns.push({ cmd, env, detached: opts.detached });
			const proc: ViewerProc = {
				pid,
				writeLine: (line) => void fake.stdin.push(JSON.parse(line)),
				closeStdin: () => {
					state.closed = true;
				},
				onLine: (listener) => {
					listeners.push(listener);
					for (const line of said) listener(line);
				},
				exited,
				kill: () => {
					state.killed = true;
					resolveExit(137);
				},
				release: () => {
					state.released = true;
				},
			};
			return proc;
		},
	};
	return fake;
}
