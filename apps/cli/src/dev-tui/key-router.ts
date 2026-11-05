import type { MetroTerminal } from "../metro";
import { actionFor, type Key, promptEdit } from "./keys";
import type { MetroPane } from "./metro-pane";
import type { ActionId, TuiState } from "./model";
import type { TuiEvent } from "./reducer";

/** Esc twice inside this window sends a literal Esc to Expo. */
export const DOUBLE_ESC_MS = 300;
const LITERAL_ESC = String.fromCharCode(27);

export type KeyRouterDeps = {
	state(): TuiState;
	now(): number;
	dispatch(event: TuiEvent): void;
	/** repaint soon: a key changed the pane without a reducer event */
	schedule(): void;
	metroTerminal(): MetroTerminal | undefined;
	pane: Pick<MetroPane, "scroll" | "scrollToBottom">;
	/** rows the Metro pane shows, for a page of history scroll */
	paneRows(): number;
	/** a list-mode action key */
	run(action: ActionId): void;
	/** the footer prompt was submitted with this text */
	submitPrompt(text: string): void;
};

/**
 * Where a key goes. The footer prompt takes every key while open; in list mode an action key runs its action.
 * Interact mode hands every key but Esc and Shift+PgUp/PgDn to Expo (Ctrl-C included: only the PTY's exit ends
 * Metro). Esc leaves; a second Esc inside `DOUBLE_ESC_MS` sends a literal Esc to Expo and stays in interact mode.
 * Everything else is a reducer `key` event.
 */
export function createKeyRouter(deps: KeyRouterDeps): (key: Key) => void {
	let leftInteractAt: number | undefined;

	/** A key in interact mode that belongs to Expo or the pane; false when it is warden's (Esc). */
	const interactKey = (key: Key): boolean => {
		const action = actionFor("interact", key);
		if (action?.type === "forward") {
			deps.pane.scrollToBottom();
			deps.metroTerminal()?.write(key.seq);
		} else if (action?.type === "pane-scroll") {
			deps.pane.scroll(-action.dir * Math.max(1, deps.paneRows() - 1));
		} else return false;
		deps.schedule();
		return true;
	};

	/** Esc right after leaving interact mode: a literal Esc for Expo when it comes inside the double-Esc window. */
	const literalEsc = (at: number): boolean => {
		const quick = leftInteractAt !== undefined && at - leftInteractAt <= DOUBLE_ESC_MS;
		leftInteractAt = undefined;
		if (!quick) return false;
		deps.metroTerminal()?.write(LITERAL_ESC);
		deps.dispatch({ type: "mode", mode: "interact" });
		return true;
	};

	const promptKey = (key: Key): void => {
		const edit = promptEdit(key);
		if (edit === undefined) return;
		if (edit.op === "submit" || edit.op === "cancel") {
			const text = deps.state().prompt?.text ?? "";
			deps.dispatch({ type: "prompt:close" });
			if (edit.op === "submit") deps.submitPrompt(text);
			return;
		}
		deps.dispatch({ type: "prompt:edit", edit });
	};

	/** A key that is not the prompt's or a list action: Expo's in interact mode, a literal Esc, or a reducer event. */
	const modeKey = (key: Key, mode: TuiState["mode"]): void => {
		const at = deps.now();
		if (mode === "interact") {
			if (interactKey(key)) return;
			leftInteractAt = at;
		} else if (key.name === "escape" && mode === "list") {
			if (literalEsc(at)) return;
		} else leftInteractAt = undefined;
		deps.dispatch({ type: "key", key, at });
	};

	return (key: Key): void => {
		const { mode } = deps.state();
		if (mode === "prompt") {
			promptKey(key);
			return;
		}
		const action = mode === "list" ? actionFor("list", key) : undefined;
		if (action?.type === "run") {
			leftInteractAt = undefined;
			deps.run(action.action);
			return;
		}
		modeKey(key, mode);
	};
}
