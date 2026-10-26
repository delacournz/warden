import type { Platform } from "@delacour/warden-core/types";
import type { CommandContext } from "../context";
import type { MetroTerminal } from "../metro";

/** The steps a person watches in `warden dev`, in order; action keys add more rows later (TUI-5). */
export type DevTaskId = "claim" | "show" | "app" | "metro" | "client" | "session";

/** A running task: end it once, with an outcome; `log` adds a line under it meanwhile. */
export type DevTaskHandle = {
	ok(detail?: string): void;
	fail(error: string): void;
	log(line: string): void;
};

/** Defined next to `MetroProc` (which carries it); re-exported so the seam keeps its names. */
export type { MetroTerminal };

/** What the ui shows once the session is up. */
export type DevReady = {
	platform: Platform;
	deviceId: string;
	deviceName: string | undefined;
	port: number;
	metroUrl: string;
	leaseIds: string[];
	app: { source: string; hash: string } | undefined;
	projectName: string;
};

/** How `warden dev` should run Metro: on the user's terminal, or in a PTY the ui renders. */
export type DevMetroMode =
	| { kind: "inherit" }
	| {
			kind: "pty";
			/** the pane's size at spawn time (PTY rows/cols) */
			size(): { cols: number; rows: number };
			/** raw PTY output; chunks can split a UTF-8 sequence, so never decode per chunk */
			onData(chunk: Uint8Array): void;
			/** the spawned PTY and its exit; `exited` (not Ctrl-C) is what says Metro is gone */
			attach(terminal: MetroTerminal, exited: Promise<number>): void;
	  };

/**
 * The seam between `warden dev`'s session logic and what the person sees. `plain` is today's output
 * (spinner + `note`/`warn`, Metro inherits the terminal); `tui` is the dashboard (`dev-tui/`). The
 * command talks only to this type, so both are tested apart and `--json` / pipes / agents stay plain.
 */
export type DevUi = {
	/** every warden line (`note`, `warn`, `reportError`, `ctx.err`) goes through this context's `err` */
	ctx: CommandContext;
	/** mark a task running; the handle ends it */
	task(id: DevTaskId, label: string): DevTaskHandle;
	metro: DevMetroMode;
	/** the session is up (device, port, Metro URL, app) */
	ready(info: DevReady): void;
	/** the ui asks to quit (`q` / Ctrl-C in list mode): the command stops Metro and releases as on a signal */
	onQuit(handler: () => void): void;
	/** restore the terminal; idempotent; always called, also after a failure */
	close(): Promise<void>;
};
