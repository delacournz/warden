import type { Result } from "@delacour/warden-types/result";
import type { Element, ScreenInfo } from "../driver.types";
import { readNode } from "./uiad-protocol";
import { parseUiadNodes } from "./uiautomator";

/**
 * Replies of the screen-reader ops of `warden-uiad` 0.6.0 (`srFocus`, `srFocused`, `srEvents`, `actionClick`,
 * `actionScroll`): a node is the snapshot's node JSON, with its visible descendants for a focus stop (so the speech
 * model can merge a row's labels). Hand-checked like the snapshot's nodes.
 */

type Parsed<T> = Result<T, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One node object as an `Element` (ids are preorder paths inside this node's own subtree). */
export function elementOfNode(raw: unknown, screen: Pick<ScreenInfo, "width" | "height">): Parsed<Element> {
	const node = readNode(raw, "node");
	if (typeof node === "string") return { success: false, error: node };
	const [element] = parseUiadNodes([node], screen).elements;
	return element === undefined ? { success: false, error: "node: not an element" } : { success: true, data: element };
}

export type SrFocusRead = { element: Element | undefined; index?: number; count: number };

/** `srFocus`: `{node, index, count}`, or `{node:null, count}` past either end. */
export function parseSrFocus(data: unknown, screen: Pick<ScreenInfo, "width" | "height">): Parsed<SrFocusRead> {
	if (!isRecord(data) || typeof data.count !== "number") return { success: false, error: "srFocus: unexpected reply" };
	if (data.node === null || data.node === undefined)
		return { success: true, data: { element: undefined, count: data.count } };
	const element = elementOfNode(data.node, screen);
	if (!element.success) return element;
	return {
		success: true,
		data: {
			element: element.data,
			count: data.count,
			...(typeof data.index === "number" ? { index: data.index } : {}),
		},
	};
}

/** `srFocused`: `{node}` or `{node:null}`. */
export function parseSrFocused(
	data: unknown,
	screen: Pick<ScreenInfo, "width" | "height">
): Parsed<Element | undefined> {
	if (!isRecord(data) || !("node" in data)) return { success: false, error: "srFocused: unexpected reply" };
	if (data.node === null) return { success: true, data: undefined };
	return elementOfNode(data.node, screen);
}

export type SrFocusEvent = { element: Element; at: number };
export type SrEventsRead = { events: SrFocusEvent[]; cursor: number; lost?: boolean };

/** `srEvents`: `{events:[{node, at}], cursor, lost?}`. */
export function parseSrEvents(data: unknown, screen: Pick<ScreenInfo, "width" | "height">): Parsed<SrEventsRead> {
	if (!isRecord(data) || !Array.isArray(data.events) || typeof data.cursor !== "number") {
		return { success: false, error: "srEvents: unexpected reply" };
	}
	const events: SrFocusEvent[] = [];
	for (const [index, raw] of data.events.entries()) {
		if (!isRecord(raw) || typeof raw.at !== "number") return { success: false, error: `srEvents: bad event ${index}` };
		const element = elementOfNode(raw.node, screen);
		if (!element.success) return { success: false, error: `srEvents[${index}]: ${element.error}` };
		events.push({ element: element.data, at: raw.at });
	}
	return { success: true, data: { events, cursor: data.cursor, ...(data.lost === true ? { lost: true } : {}) } };
}

/** `actionScroll`: `{scrolled}` (false at the end of the content). */
export function parseScrolled(data: unknown): Parsed<boolean> {
	return isRecord(data) && typeof data.scrolled === "boolean"
		? { success: true, data: data.scrolled }
		: { success: false, error: "actionScroll: unexpected reply" };
}
