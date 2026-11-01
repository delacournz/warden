import { join } from "node:path";
import type { MetricsTarget } from "@delacour/warden-sdk/ops/perf/metrics-sampler";
import { storeLocator } from "@delacour/warden-store/store";
import { resultFactory } from "@delacour/warden-types/result";
import type { DevMetroMode, DevReady, DevTaskHandle, DevTaskId, DevUi, MetroTerminal } from "../commands/dev-ui";
import type { CommandContext } from "../context";
import type { Spinner } from "../ui";
import { devTuiActions } from "./actions";
import { devTuiActionsEffects } from "./actions.effects";
import { devTuiHud, HUD_DEFAULT_INTERVAL_MS, type Hud, type HudDeps } from "./hud";
import { devTuiKeys, type Key } from "./keys";
import { devTuiMetroPane } from "./metro-pane";
import { devTuiModel, type Size } from "./model";
import { devTuiReducer, type TuiEvent } from "./reducer";
import { devTuiRender, type RenderPane } from "./render";
import { devTuiScreen, type ScreenInput, type ScreenOutput, type ScreenProcess } from "./screen";
import { devTuiSessionLog } from "./session-log";

export type DevTuiDeps = {
	/** the command context; the returned `ctx` is a copy whose output lands in the task rows */
	ctx: CommandContext;
	stdin?: ScreenInput;
	stdout?: ScreenOutput;
	proc?: ScreenProcess;
	/** terminal size now; default reads `stdout.columns/rows` */
	size?: () => Size;
	now?: () => number;
	/** the perf HUD (`--hud`, `--hud-interval`); off or absent = no ticker until `h` / `setHud(true)` */
	hud?: { enabled: boolean; intervalMs: number };
	/** test seams for the HUD ticker: the sampler, frame source and scheduler */
	hudSeams?: Pick<HudDeps, "sampler" | "fps" | "schedule" | "fpsEvery">;
};

/** `DevUi` plus what the Metro pane (TUI-4) and the actions (TUI-5) plug into. */
export type DevTui = DevUi & {
	/** every raw Metro PTY chunk so far, undecoded (the TUI-4 pane feeds them to xterm) */
	metroChunks(): readonly Uint8Array[];
	/** the Metro PTY handle once `metro.attach` ran: key forwarding and resize */
	metroTerminal(): MetroTerminal | undefined;
};

/** Frames are painted at most this often; events in between coalesce. */
/** warden lines the dashboard keeps for the terminal after a failure; the tail of them after a Metro death. */
const TRANSCRIPT_LINES = 400;
const TRANSCRIPT_TAIL = 20;

export const FRAME_MS = 16;

/** Smallest PTY Metro is given, however small the terminal is. */
const MIN_PTY = { cols: 20, rows: 5 };

/** Esc twice inside this window sends a literal Esc to Expo. */
const DOUBLE_ESC_MS = 300;
const LITERAL_ESC = String.fromCharCode(27);

export class DevTuiTui {
	private processAdapter(): ScreenProcess {
		return {
			on: (event, listener) => process.on(event, listener),
			off: (event, listener) => process.off(event, listener),
			listenerCount: (event) => process.listenerCount(event),
			exit: (code) => process.exit(code),
		};
	}

	private stdinAdapter(): ScreenInput {
		return {
			isTTY: process.stdin.isTTY,
			setRawMode: (raw) => process.stdin.setRawMode?.(raw),
			on: (event, listener) => process.stdin.on(event, listener),
			off: (event, listener) => process.stdin.off(event, listener),
			resume: () => process.stdin.resume(),
			pause: () => process.stdin.pause(),
		};
	}

	/**
	 * The dashboard behind `DevUi`: task list, the selected task's log, footer hints, help overlay. Takes the terminal
	 * on creation (restore handlers first) and gives it back in `close()`.
	 */
	createDevTui(deps: DevTuiDeps): DevTui {
		const now = deps.now ?? (() => Date.now());
		const screen = devTuiScreen.createScreen({
			stdin: deps.stdin ?? this.stdinAdapter(),
			stdout: deps.stdout ?? process.stdout,
			proc: deps.proc ?? this.processAdapter(),
			...(deps.size ? { size: deps.size } : {}),
		});

		let state = devTuiModel.initialState(screen.size(), now());
		let quitHandler: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		let drawnRedraw = state.redraw;
		const running: string[] = [];
		let lastStarted: string | undefined;
		const metroChunks: Uint8Array[] = [];
		let metroTerminal: MetroTerminal | undefined;

		// --- TUI-4: Metro pane + key passthrough (the pane, interact-mode keys, resize) ---
		const paneSize = (): { cols: number; rows: number } => {
			const { cols, rows } = screen.size();
			return {
				cols: Math.max(MIN_PTY.cols, cols - devTuiRender.listWidth(cols) - 3),
				rows: Math.max(MIN_PTY.rows, rows - 2),
			};
		};
		const pane = devTuiMetroPane.createMetroPane(paneSize());
		let leftInteractAt: number | undefined;

		/** The pane as the renderer takes it; only built while the metro row is on screen. */
		const livePane = (): RenderPane | undefined =>
			state.tasks[state.selected]?.id === "metro" ? { rows: pane.rows(), cursor: pane.cursor() } : undefined;

		const resizePane = (): void => {
			const size = paneSize();
			pane.resize(size.cols, size.rows);
			metroTerminal?.resize(size.cols, size.rows);
		};

		/** A key in interact mode that belongs to Expo or the pane; false when it is warden's (Esc). */
		const interactKey = (key: Key): boolean => {
			const action = devTuiKeys.actionFor("interact", key);
			if (action?.type === "forward") {
				pane.scrollToBottom();
				metroTerminal?.write(key.seq);
			} else if (action?.type === "pane-scroll") {
				pane.scroll(-action.dir * Math.max(1, paneSize().rows - 1));
			} else return false;
			schedule();
			return true;
		};

		/** Esc right after leaving interact mode: a literal Esc for Expo when it comes inside the double-Esc window. */
		const literalEsc = (at: number): boolean => {
			const quick = leftInteractAt !== undefined && at - leftInteractAt <= DOUBLE_ESC_MS;
			leftInteractAt = undefined;
			if (!quick) return false;
			metroTerminal?.write(LITERAL_ESC);
			dispatch({ type: "mode", mode: "interact" });
			return true;
		};

		/**
		 * Interact mode hands every key but Esc and Shift+PgUp/PgDn to Expo (Ctrl-C included: only the PTY's exit ends
		 * Metro). Esc leaves; a second Esc inside the window sends a literal Esc to Expo and stays in interact mode.
		 */
		const handleKey = (key: Key): void => {
			const at = now();
			if (state.mode === "interact") {
				if (interactKey(key)) return;
				leftInteractAt = at;
			} else if (key.name === "escape" && state.mode === "list") {
				if (literalEsc(at)) return;
			} else leftInteractAt = undefined;
			dispatch({ type: "key", key, at });
		};

		/** TUI-5: the footer prompt takes every key; in list mode an action key runs its action. Anything else is TUI-4's. */
		const routeKey = (key: Key): void => {
			if (state.mode === "prompt") {
				promptKey(key);
				return;
			}
			const action = state.mode === "list" ? devTuiKeys.actionFor("list", key) : undefined;
			if (action?.type !== "run") {
				handleKey(key);
				return;
			}
			leftInteractAt = undefined;
			void actions.run(action.action);
		};
		// --- end TUI-4 ---

		const paint = (): void => {
			timer = undefined;
			if (closed) return;
			const size = screen.size();
			if (state.redraw !== drawnRedraw) {
				drawnRedraw = state.redraw;
				screen.invalidate();
			}
			const metro = livePane();
			screen.draw(
				devTuiRender.render(state, size.cols, size.rows, metro),
				metro ? devTuiRender.paneCursor(state, size.cols, metro.cursor) : undefined
			);
		};
		const schedule = (): void => {
			if (timer !== undefined || closed) return;
			timer = setTimeout(paint, FRAME_MS);
		};

		const dispatch = (event: TuiEvent): void => {
			const before = state;
			state = devTuiReducer.reduce(state, event);
			if (!before.quitting && state.quitting) quitHandler?.();
			if (before.hud.visible !== state.hud.visible) syncHud();
			recordEvent(event);
			schedule();
		};

		// TUI-6 begin: the HUD ticker and the session log on disk (`$WARDEN_HOME/dev/<leaseId>/`)
		const sessionLog = devTuiSessionLog.openSessionLog(undefined, { now });
		let hudTarget: MetricsTarget | undefined;
		/** the sampler runs exactly while the HUD is visible: `h`, `setHud` and `warden dev enable hud` all flip `visible` */
		let hudTicker: Hud | undefined;
		const syncHud = (): void => {
			const want = state.hud.visible && !closed;
			if (want && hudTicker === undefined) {
				hudTicker = devTuiHud.startHud({
					ctx: deps.ctx,
					target: () => hudTarget,
					intervalMs: deps.hud?.intervalMs ?? HUD_DEFAULT_INTERVAL_MS,
					onSample: (sample, fps) => dispatch({ type: "hud:sample", sample, fps, at: now() }),
					now,
					...deps.hudSeams,
				});
			} else if (!want && hudTicker !== undefined) {
				hudTicker.stop();
				hudTicker = undefined;
			}
		};
		state = { ...state, hud: { ...state.hud, visible: deps.hud?.enabled === true } };
		syncHud();
		function recordEvent(event: TuiEvent): void {
			if (event.type === "task:log") sessionLog.line(event.id, event.line);
			else if (event.type === "task:fail") sessionLog.line(event.id, `failed: ${event.error}`);
			else if (event.type === "task:ok" && event.detail) sessionLog.line(event.id, event.detail);
		}
		let logDir: string | undefined;
		function sessionReady(info: DevReady): void {
			const lease = info.leaseIds[0];
			if (lease !== undefined) {
				logDir = join(storeLocator.wardenHome(deps.ctx.env), "dev", lease);
				sessionLog.attach(logDir);
			}
			if (info.bundleId !== undefined) hudTarget = { udid: info.deviceId, platform: info.platform, app: info.bundleId };
		}
		function stopSessionExtras(): void {
			syncHud();
			sessionLog.close();
		}
		// TUI-6 end

		// TUI-5 begin: the warden action keys (`actions.ts`), with real effects and a footer prompt for `m`
		let metroSwap = false;
		const effects = devTuiActionsEffects.createActionEffects({
			ctx: deps.ctx,
			host: () => state.ready?.actions,
			metroTerminal: () => metroTerminal,
			shotsDir: () => sessionLog.shotsDir(),
		});
		const actions = devTuiActions.createActions({
			now,
			ready: () => state.ready,
			sink: {
				start: (id, title) => dispatch({ type: "task:start", id, title, at: now() }),
				log: (id, line) => dispatch({ type: "task:log", id, line }),
				title: (id, title) => dispatch({ type: "task:title", id, title }),
				ok: (id, detail) => dispatch({ type: "task:ok", id, detail, at: now() }),
				fail: (id, error) => dispatch({ type: "task:fail", id, error, at: now() }),
				hudPerf: (perf) => dispatch({ type: "hud:perf", perf }),
				prompt: (label) => dispatch({ type: "prompt:open", label }),
			},
			fx: {
				...effects,
				restartMetro: async (log) => {
					metroSwap = true;
					try {
						return await effects.restartMetro(log);
					} finally {
						metroSwap = false;
					}
				},
			},
			every: (fn, ms) => {
				const handle = setInterval(fn, ms);
				return () => clearInterval(handle);
			},
		});
		function promptKey(key: Key): void {
			const edit = devTuiKeys.promptEdit(key);
			if (edit === undefined) return;
			if (edit.op === "submit" || edit.op === "cancel") {
				const text = state.prompt?.text ?? "";
				dispatch({ type: "prompt:close" });
				if (edit.op === "submit") void actions.submitMark(text);
				return;
			}
			dispatch({ type: "prompt:edit", edit });
		}
		// TUI-5 end

		const parser = devTuiKeys.createKeyParser(routeKey);
		screen.onInput((chunk) => parser.feed(chunk));
		screen.onResize((size) => {
			dispatch({ type: "resize", size });
			resizePane();
		});
		paint();

		const currentTask = (): string => {
			if (state.quitting || state.ready) return "session";
			return running[running.length - 1] ?? lastStarted ?? "claim";
		};
		/** warden's own lines, for the terminal after the dashboard closes on a failure (they lived only in the alt screen) */
		const transcript: string[] = [];
		const lineTo = (line: string): void => {
			if (transcript.push(line) > TRANSCRIPT_LINES) transcript.shift();
			dispatch({ type: "task:log", id: currentTask(), line });
		};

		const ui = deps.ctx.ui;
		const spinner = (text: string): Spinner => {
			lineTo(text);
			return {
				update: (next) => dispatch({ type: "task:title", id: currentTask(), title: next }),
				log: lineTo,
				succeed: (next) => {
					if (next) lineTo(next);
				},
				fail: (next) => {
					if (next) lineTo(next);
				},
				stop: () => undefined,
			};
		};
		const ctx: CommandContext = {
			...deps.ctx,
			out: lineTo,
			err: lineTo,
			ui: { ...ui, interactive: false, rich: false, spinner },
		};

		/** The pane's latest `Bundled …` line to the HUD, once per change. */
		let lastBundle: { ms: number; modules: number } | undefined;
		const publishBundle = (): void => {
			if (closed) return;
			const info = pane.bundleInfo();
			if (!info || (info.ms === lastBundle?.ms && info.modules === lastBundle.modules)) return;
			lastBundle = { ms: info.ms, modules: info.modules };
			dispatch({ type: "hud:bundle", bundle: lastBundle });
		};

		const metro: DevMetroMode = {
			kind: "pty",
			size: paneSize,
			onData: (chunk) => {
				metroChunks.push(chunk);
				sessionLog.metro(chunk);
				if (!closed) void pane.write(chunk).then(publishBundle).then(schedule);
			},
			attach: (terminal, exited) => {
				metroTerminal = terminal;
				// a restart (`c`) ends the old Metro on purpose: that exit is not the session's
				void exited.then(
					(code) => {
						if (!metroSwap) dispatch({ type: "metro:exit", code, at: now() });
					},
					() => {
						if (!metroSwap) dispatch({ type: "metro:exit", code: 1, at: now() });
					}
				);
			},
		};

		return {
			ctx,
			metro,
			metroChunks: () => metroChunks,
			metroTerminal: () => metroTerminal,
			task(id: DevTaskId, label: string): DevTaskHandle {
				let ended = false;
				lastStarted = id;
				running.push(id);
				dispatch({ type: "task:start", id, title: label, at: now() });
				const end = (event: TuiEvent): void => {
					if (ended) return;
					ended = true;
					const index = running.lastIndexOf(id);
					if (index !== -1) running.splice(index, 1);
					dispatch(event);
				};
				return {
					ok: (detail) => end({ type: "task:ok", id, detail, at: now() }),
					fail: (error) => end({ type: "task:fail", id, error, at: now() }),
					log: (line) => dispatch({ type: "task:log", id, line }),
				};
			},
			ready(info: DevReady): void {
				dispatch({ type: "ready", info, at: now() });
				sessionReady(info);
			},
			onQuit(handler) {
				quitHandler = handler;
			},
			setHud(on) {
				if (state.hud.visible !== on) dispatch({ type: "hud:visible", on });
				return resultFactory.ok(undefined);
			},
			hudOn: () => hudTicker !== undefined,
			async close() {
				if (closed) return;
				if (timer !== undefined) clearTimeout(timer);
				closed = true;
				actions.dispose();
				stopSessionExtras();
				pane.dispose();
				screen.close();
				replayFailure();
			},
		};

		/**
		 * The dashboard closing on a failure (the session never came up, or Metro died) would take every message
		 * with it: print warden's lines (all of them before `ready`, the tail after) to the real stderr, then the log dir.
		 */
		function replayFailure(): void {
			const quit = state.quitting;
			const metroDied = state.metroExit !== undefined && state.metroExit !== 0;
			const neverReady = state.ready === undefined;
			if (quit || (!neverReady && !metroDied)) return;
			const lines = neverReady ? transcript : transcript.slice(-TRANSCRIPT_TAIL);
			for (const line of lines) deps.ctx.err(line);
			if (logDir !== undefined) deps.ctx.err(`session log: ${logDir}`);
		}
	}
}

export const devTuiTui = new DevTuiTui();
