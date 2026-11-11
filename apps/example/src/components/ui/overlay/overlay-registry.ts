/** The band of the z-order an overlay draws in. */
export type OverlayLayer = "modal" | "anchored" | "toast";

export const OVERLAY_LAYERS = ["modal", "anchored", "toast"] as const satisfies readonly OverlayLayer[];

/**
 * Where each layer's band starts.
 *
 * Every overlay and every bottom sheet teleports into the same `"root"` host, so
 * they are siblings ordered by `zIndex`. The sheet engine stamps its sheets from
 * 1 upward; starting the first band at 1000 puts every overlay above every sheet.
 * A dialog sits under a popover opened from it, and a toast sits above both.
 */
export const OVERLAY_LAYER_BASE = {
	modal: 1000,
	anchored: 2000,
	toast: 3000,
} as const satisfies Record<OverlayLayer, number>;

/** The layers whose top overlay answers Android's back button. A toast never does. */
const BACK_CAPTURING_LAYERS: ReadonlySet<OverlayLayer> = new Set(["modal", "anchored"]);

/** One overlay that is presented — open, or animating closed. */
export type OverlayRegistryEntry = {
	id: string;
	layer: OverlayLayer;
	/** Open order across every layer; later is larger. */
	seq: number;
	/** Playing its exit animation: still drawn, no longer what the screen is about. */
	isExiting: boolean;
	/**
	 * Draws inside the provider's app content `View` — inline, or in a host other
	 * than `"root"` — rather than in the `"root"` host beside it.
	 */
	isInApp: boolean;
};

export type OverlayRegistryState = {
	nextSeq: number;
	open: readonly OverlayRegistryEntry[];
};

export const INITIAL_OVERLAY_REGISTRY: OverlayRegistryState = { nextSeq: 1, open: [] };

export type OverlayRegistryAction =
	| { type: "open"; id: string; layer: OverlayLayer; isInApp?: boolean }
	| { type: "exiting"; id: string; isExiting: boolean }
	| { type: "close"; id: string };

/**
 * The registry as a pure reducer, so the z-order is testable without a renderer.
 *
 * An `open` stamps the next sequence number; an overlay already open is
 * re-stamped rather than duplicated, which brings it forward and keeps its
 * `isExiting`. `isInApp` defaults to false. An `exiting` marks an overlay that is animating closed, and
 * keeps its place in the z-order. A `close` of an overlay that is not open, or an `exiting` that
 * changes nothing, returns the same state object, so an unmount racing an exit
 * causes no render.
 */
export function reduceOverlayRegistry(
	state: OverlayRegistryState,
	action: OverlayRegistryAction
): OverlayRegistryState {
	switch (action.type) {
		case "close": {
			if (!state.open.some((entry) => entry.id === action.id)) return state;
			return { ...state, open: state.open.filter((entry) => entry.id !== action.id) };
		}
		case "exiting": {
			const entry = state.open.find((candidate) => candidate.id === action.id);
			if (entry === undefined || entry.isExiting === action.isExiting) return state;
			return {
				...state,
				open: state.open.map((candidate) =>
					candidate === entry ? { ...candidate, isExiting: action.isExiting } : candidate
				),
			};
		}
		case "open": {
			const previous = state.open.find((entry) => entry.id === action.id);
			const others = state.open.filter((entry) => entry !== previous);
			const isExiting = previous?.isExiting ?? false;
			return {
				nextSeq: state.nextSeq + 1,
				open: [
					...others,
					{ id: action.id, layer: action.layer, seq: state.nextSeq, isExiting, isInApp: action.isInApp ?? false },
				],
			};
		}
	}
}

/**
 * The overlay's `zIndex` while presented, `0` otherwise.
 *
 * Its layer's base plus its rank among the open overlays of that layer — a rank,
 * not the raw sequence number, so a long session's thousandth dialog still sits
 * below the first popover.
 */
export function zIndexOfOverlay(state: OverlayRegistryState, id: string): number {
	const entry = state.open.find((candidate) => candidate.id === id);
	if (entry === undefined) return 0;
	let rank = 1;
	for (const other of state.open) {
		if (other.layer === entry.layer && other.seq < entry.seq) rank++;
	}
	return OVERLAY_LAYER_BASE[entry.layer] + rank;
}

/** The back-capturing overlay drawn on top, or `null` when none is presented. */
export function topOverlay(state: OverlayRegistryState): string | null {
	let top: string | null = null;
	let topZ = 0;
	for (const entry of state.open) {
		if (!BACK_CAPTURING_LAYERS.has(entry.layer)) continue;
		const z = zIndexOfOverlay(state, entry.id);
		if (z > topZ) {
			top = entry.id;
			topZ = z;
		}
	}
	return top;
}

/** Whether `id` is the overlay a back press should close. */
export function isTopOverlay(state: OverlayRegistryState, id: string): boolean {
	return topOverlay(state) === id;
}

/**
 * Whether a modal overlay is open and not animating closed.
 *
 * Every overlay teleports into the `"root"` host, which sits beside the app
 * content, not above it in the view tree. A panel's `accessibilityViewIsModal`
 * hides only its own siblings in that host, so `OverlayProvider` uses this to
 * hide the app content from screen readers while a dialog or drawer is up.
 *
 * An exiting modal does not count. Its `onExited` is where a dialog moves
 * focus back to its trigger, and the trigger must be reachable by then.
 */
export function hasModalOverlay(state: OverlayRegistryState): boolean {
	return state.open.some((entry) => entry.layer === "modal" && !entry.isExiting);
}

/**
 * Whether `OverlayProvider` must hide its app content from screen readers.
 *
 * True while a modal that is not exiting draws in the `"root"` host, beside the
 * app content. A modal that draws inside the app content — inline, or in another
 * host — does not count: hiding the content would hide that modal too. It still
 * stacks and answers the back button like any other modal.
 */
export function hidesAppContent(state: OverlayRegistryState): boolean {
	return state.open.some((entry) => entry.layer === "modal" && !entry.isExiting && !entry.isInApp);
}

/**
 * The modal overlay drawn on top that is not animating closed, or `null`.
 *
 * Its portal frame is the one screen readers stay inside. A popover or toast
 * above it is in a higher band and stays reachable.
 */
export function topModalOverlay(state: OverlayRegistryState): string | null {
	let top: string | null = null;
	let topZ = 0;
	for (const entry of state.open) {
		if (entry.layer !== "modal" || entry.isExiting) continue;
		const z = zIndexOfOverlay(state, entry.id);
		if (z > topZ) {
			top = entry.id;
			topZ = z;
		}
	}
	return top;
}

/**
 * Whether `id` draws under the top modal overlay and must be hidden from
 * screen readers.
 *
 * Every overlay draws in the same `"root"` host as the top modal, so hiding
 * the app content does not hide a dialog under another dialog. Each portal
 * reads this and hides its own frame.
 */
export function isBelowTopModal(state: OverlayRegistryState, id: string): boolean {
	const top = topModalOverlay(state);
	if (top === null || top === id) return false;
	const z = zIndexOfOverlay(state, id);
	return z !== 0 && z < zIndexOfOverlay(state, top);
}
