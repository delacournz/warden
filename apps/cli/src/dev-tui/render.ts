import { SYMBOLS } from "../ui";
import { devTuiAnsi } from "./ansi";
import { devTuiKeys, EXPO_KEYS, LIST_BINDINGS } from "./keys";
import { MIN_COLS, MIN_ROWS, type Task, type TuiState } from "./model";

const ESC = String.fromCharCode(27);

/** The HUD slot (TUI-6 fills it) shows from this width. */
export const HUD_MIN_COLS = 100;

/** The HUD box, borders included. */
export const HUD_WIDTH = 34;

/** The Metro pane as the renderer sees it: styled rows (at most the pane's width) and the cursor in them. */
export type RenderPane = { rows: readonly string[]; cursor: { x: number; y: number; visible: boolean } };

const SPARK = "▁▂▃▄▅▆▇█";
/** CPU readings shown in the box (the ticker keeps 30; the box only has room for the latest). */
const SPARK_WIDTH = 10;
/** A window that never passes this still draws low bars, so an idle app does not look busy. */
const SPARK_FLOOR_PCT = 20;

export class DevTuiRender {
	private sgr(code: string, text: string): string {
		return `${ESC}[${code}m${text}${ESC}[0m`;
	}

	private dim(text: string): string {
		return this.sgr("2", text);
	}

	private bold(text: string): string {
		return this.sgr("1", text);
	}

	private cyan(text: string): string {
		return this.sgr("36", text);
	}

	private green(text: string): string {
		return this.sgr("32", text);
	}

	private red(text: string): string {
		return this.sgr("31", text);
	}

	/** Width of the task column: a third of the terminal, at most 32. */
	listWidth(cols: number): number {
		return Math.min(32, Math.floor(cols / 3));
	}

	/** `412ms`, `1.3s`, `2m05s`. */
	formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const minutes = Math.floor(ms / 60_000);
		const seconds = Math.floor((ms % 60_000) / 1000);
		return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	}

	private symbolFor(task: Task): string {
		switch (task.status) {
			case "pending":
				return this.dim(SYMBOLS.idle);
			case "running":
				return this.cyan(SYMBOLS.run);
			case "ok":
				return this.green(SYMBOLS.ok);
			case "fail":
				return this.red(SYMBOLS.fail);
		}
	}

	private titleFor(task: Task, selected: boolean): string {
		if (task.status === "pending") return this.dim(task.title);
		if (task.status === "fail") return this.red(task.title);
		return selected ? this.bold(task.title) : task.title;
	}

	private taskRow(task: Task, selected: boolean, width: number): string {
		const marker = selected ? this.cyan("›") : " ";
		const done =
			(task.status === "ok" || task.status === "fail") && task.startedAt !== undefined && task.endedAt !== undefined;
		const duration = done ? this.formatDuration((task.endedAt ?? 0) - (task.startedAt ?? 0)) : "";
		const titleWidth = Math.max(1, width - 4 - (duration ? duration.length + 1 : 0));
		const title = devTuiAnsi.fit(this.titleFor(task, selected), titleWidth);
		return devTuiAnsi.fit(
			`${marker} ${this.symbolFor(task)} ${title}${duration ? ` ${this.dim(duration)}` : ""}`,
			width
		);
	}

	private paneLines(task: Task | undefined): string[] {
		if (!task) return [];
		const lines = task.id === "metro" ? [this.dim("Metro output appears here"), ...task.log] : task.log;
		if (lines.length > 0) return lines;
		return [this.dim(task.status === "pending" ? "waiting" : "no output")];
	}

	/** Rows of the live Metro pane, or undefined while it has nothing to show (the placeholder path then applies). */
	private metroPaneRows(task: Task | undefined, state: TuiState, pane: RenderPane | undefined, height: number) {
		if (task?.id !== "metro" || !pane) return undefined;
		let used = pane.rows.length;
		while (used > 0 && devTuiAnsi.stripAnsi(pane.rows[used - 1] ?? "").trim() === "") used--;
		if (used === 0) return undefined;
		if (state.metroExit !== undefined) return [...pane.rows.slice(0, used), ...task.log].slice(-height);
		return Array.from({ length: height }, (_, y) => pane.rows[y] ?? "");
	}

	/** Where the real cursor goes (0-based screen column and row): the pane's cursor while interacting with a live Metro. */
	paneCursor(state: TuiState, cols: number, cursor: RenderPane["cursor"]): { x: number; y: number } | undefined {
		if (state.mode !== "interact" || !cursor.visible || state.metroExit !== undefined) return undefined;
		if (state.tasks[state.selected]?.id !== "metro") return undefined;
		return { x: Math.min(cols - 1, this.listWidth(cols) + 2 + cursor.x), y: 1 + cursor.y };
	}

	/** The last `height` wrapped rows of the selected task's log, `scroll` rows above the tail. */
	private logWindow(task: Task | undefined, width: number, height: number): string[] {
		const wrapped = this.paneLines(task).flatMap((line) => devTuiAnsi.wrap(line, width));
		const maxScroll = Math.max(0, wrapped.length - height);
		const scroll = Math.min(task?.scroll ?? 0, maxScroll);
		const end = wrapped.length - scroll;
		return wrapped.slice(Math.max(0, end - height), end);
	}

	private header(state: TuiState, cols: number): string {
		const { ready } = state;
		const left = `${this.bold("warden dev")}${this.dim(ready ? ` · ${ready.platform} · ${ready.projectName}` : "")}`;
		const hud = cols >= HUD_MIN_COLS ? this.dim(`hud ${state.hud.visible ? "on" : "off"}`) : "";
		const hudWidth = hud ? devTuiAnsi.visibleWidth(hud) + 1 : 0;
		const info = ready
			? this.dim([ready.deviceName ?? ready.deviceId, `:${ready.port}`, ready.metroUrl].join(" · "))
			: "";
		const room = cols - devTuiAnsi.visibleWidth(left) - 2 - hudWidth;
		const infoCut = info && room > 0 ? devTuiAnsi.truncate(info, room) : "";
		const gap = Math.max(1, cols - devTuiAnsi.visibleWidth(left) - devTuiAnsi.visibleWidth(infoCut) - hudWidth);
		return devTuiAnsi.fit(`${left}${" ".repeat(gap)}${infoCut}${hud ? ` ${hud}` : ""}`, cols);
	}

	private sparkline(values: readonly number[]): string {
		const shown = values.slice(-SPARK_WIDTH);
		const top = Math.max(SPARK_FLOOR_PCT, ...shown);
		return shown
			.map(
				(v) => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.round((Math.max(0, v) / top) * (SPARK.length - 1))))]
			)
			.join("");
	}

	private clock(ms: number, withHours: boolean): string {
		const total = Math.max(0, Math.floor(ms / 1000));
		const pad = (n: number): string => String(n).padStart(2, "0");
		const seconds = pad(total % 60);
		const minutes = Math.floor(total / 60);
		return withHours
			? `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${seconds}`
			: `${pad(minutes)}:${seconds}`;
	}

	private hudReading(state: TuiState): string[] {
		const { sample, fps } = state.hud;
		if (sample === undefined || sample.kind === "waiting") return [this.dim("waiting for the app")];
		if (sample.kind === "not-running")
			return sample.reason ? [this.dim("app not running"), this.dim(sample.reason)] : [this.dim("app not running")];
		const pct = sample.cpuPct === undefined ? "  —" : `${String(Math.round(sample.cpuPct)).padStart(3)}%`;
		const mb = `${Math.round(sample.memKb / 1024)} MB`;
		const lines = [`cpu ${pct.padStart(4)} ${this.cyan(this.sparkline(sample.cpuHistory))} ${sample.memKind} ${mb}`];
		if (state.ready?.platform !== "android") lines.push(this.dim("fps —  (iOS sim: no frame API)"));
		else lines.push(fps ? `fps ${Math.round(fps.fps)}  jank ${Math.round(fps.jankPct)}%` : "fps —");
		return lines;
	}

	private hudBody(state: TuiState): string[] {
		const { bundle, perf } = state.hud;
		const lines = this.hudReading(state);
		lines.push(
			bundle ? `metro bundled ${(bundle.ms / 1000).toFixed(1)} s · ${bundle.modules} mods` : this.dim("metro —")
		);
		if (perf)
			lines.push(`perf ${this.red("●")} rec ${this.clock(state.now - perf.startedAt, false)}  marks ${perf.marks}`);
		return lines;
	}

	/**
	 * The HUD box (34 columns wide) the top right of the right pane is overlaid with, or undefined when it is off
	 * or the terminal is under `HUD_MIN_COLS`. Everything comes from `state.hud`; nothing here reads a clock.
	 */
	hudLines(state: TuiState, cols: number): string[] | undefined {
		if (!state.hud.visible || cols < HUD_MIN_COLS) return undefined;
		const inner = HUD_WIDTH - 2;
		const device = state.ready ? (state.ready.deviceName ?? state.ready.deviceId) : "warden";
		const started = state.hud.sessionStartedAt;
		const time = this.clock(started === undefined ? 0 : state.now - started, true);
		const name = devTuiAnsi.truncate(device, inner - time.length - 6);
		const head = ` ${name} ── ${time} `;
		const top = this.dim(`┌${head}${"─".repeat(Math.max(0, inner - devTuiAnsi.visibleWidth(head)))}┐`);
		const side = this.dim("│");
		const body = this.hudBody(state).map((line) => `${side}${devTuiAnsi.fit(` ${line}`, inner)}${side}`);
		return [top, ...body, this.dim(`└${"─".repeat(inner)}┘`)].map((line) => devTuiAnsi.fit(line, HUD_WIDTH));
	}

	private footer(state: TuiState, cols: number): string {
		if (state.quitting) return devTuiAnsi.fit(this.dim("stopping… waiting for Metro and the device to release"), cols);
		if (state.mode === "prompt" && state.prompt)
			return devTuiAnsi.fit(
				`${this.bold(`${state.prompt.label}:`)} ${state.prompt.text}${this.cyan("▏")}  ${this.dim(devTuiKeys.footerHint("prompt"))}`,
				cols
			);
		const task = state.tasks[state.selected];
		const scrolled = state.mode === "log" && task && task.scroll > 0 ? ` · ↑${task.scroll}` : "";
		return devTuiAnsi.fit(this.dim(`${devTuiKeys.footerHint(state.mode)}${scrolled}`), cols);
	}

	private helpBox(cols: number, bodyHeight: number): { rows: string[]; x: number; y: number } {
		const boxWidth = Math.min(cols - 2, 96);
		const inner = boxWidth - 2;
		const gap = 2;
		const colWidth = Math.floor((inner - 2 - gap * 2) / 3);
		const entries = LIST_BINDINGS.filter((b) => !b.hidden).map((b) => `${b.label.padEnd(8)} ${b.desc}`);
		const split = Math.ceil(entries.length / 2);
		const warden = [entries.slice(0, split), entries.slice(split)];
		const expo = EXPO_KEYS.map((k) => `${k.label.padEnd(8)} ${k.desc}`);
		const lineCount = Math.max(split, expo.length);
		const cell = (text: string | undefined): string => devTuiAnsi.fit(text ?? "", colWidth);
		const row = (a: string | undefined, b: string | undefined, c: string | undefined): string =>
			devTuiAnsi.fit(` ${cell(a)}${" ".repeat(gap)}${cell(b)}${" ".repeat(gap)}${cell(c)}`, inner);
		const body = [
			row(this.bold("warden"), "", this.bold("Expo (interact)")),
			...Array.from({ length: lineCount }, (_, i) => row(warden[0]?.[i], warden[1]?.[i], expo[i])),
			row(this.dim("tab: scroll the log"), "", this.dim("esc ? q close")),
		];
		const title = " keys ";
		const top = `┌${title}${"─".repeat(Math.max(0, inner - title.length))}┐`;
		const rows = [top, ...body.map((line) => `│${line}│`), `└${"─".repeat(inner)}┘`].map((line) =>
			devTuiAnsi.fit(line, boxWidth)
		);
		return { rows, x: Math.floor((cols - boxWidth) / 2), y: Math.max(0, Math.floor((bodyHeight - rows.length) / 2)) };
	}

	/** Pure: the whole frame as `rows` strings of exactly `cols` visible columns. */
	render(state: TuiState, cols: number, rows: number, pane?: RenderPane): string[] {
		if (cols < MIN_COLS || rows < MIN_ROWS) {
			return [
				devTuiAnsi.fit("terminal too small", cols),
				...Array.from({ length: Math.max(0, rows - 1) }, () => " ".repeat(cols)),
			];
		}
		const bodyHeight = rows - 2;
		const left = this.listWidth(cols);
		const right = cols - left - 1;
		const selectedTask = state.tasks[state.selected];
		const log =
			this.metroPaneRows(selectedTask, state, pane, bodyHeight) ?? this.logWindow(selectedTask, right - 1, bodyHeight);
		const divider = state.mode === "log" ? this.cyan("│") : this.dim("│");
		let body = Array.from({ length: bodyHeight }, (_, y) => {
			const task = state.tasks[y];
			const listCell = task ? this.taskRow(task, y === state.selected, left) : " ".repeat(left);
			return `${listCell}${divider}${devTuiAnsi.fit(` ${log[y] ?? ""}`, right)}`;
		});
		const hudBox = this.hudLines(state, cols);
		if (hudBox) {
			const x = cols - HUD_WIDTH;
			body = body.map((line, y) => {
				const boxRow = hudBox[y];
				return boxRow === undefined ? line : `${devTuiAnsi.sliceColumns(line, 0, x)}${boxRow}`;
			});
		}
		if (state.mode === "help") {
			const box = this.helpBox(cols, bodyHeight);
			body = body.map((line, y) => {
				const boxRow = box.rows[y - box.y];
				if (boxRow === undefined) return line;
				return `${devTuiAnsi.sliceColumns(line, 0, box.x)}${boxRow}${devTuiAnsi.sliceColumns(line, box.x + devTuiAnsi.visibleWidth(boxRow), cols)}`;
			});
		}
		return [this.header(state, cols), ...body.map((line) => devTuiAnsi.fit(line, cols)), this.footer(state, cols)];
	}
}

export const devTuiRender = new DevTuiRender();
