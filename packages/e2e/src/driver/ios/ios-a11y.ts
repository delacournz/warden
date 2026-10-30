import type { Result } from "@delacour/warden-types/result";
import { type A11yEventsRead, parseInjectEvents } from "../a11y-events";
import type { DriverError, DriverResult, Element, ElementA11y, LaunchOptions, Rect, Snapshot } from "../driver.types";
import { driverErr, driverError } from "../errors";
import {
	type InjectChannel,
	type InjectFs,
	injectA11yPath,
	injectEventsPath,
	injectLaunchEnv,
	nodeInjectFs,
} from "./inject";
import { INJECT_ACK_MS, INJECT_LOAD_MS } from "./ios-network";

/**
 * iOS screen-reader facts (WDN-A11Y, A11Y-1). `warden-simd` (idb) has no hint, custom actions, `isAccessibilityElement`
 * or order, so they come from the injected dylib's UIKit walk (`native/ios-inject`, op `a11yRead` on the state/ack file
 * channel of `inject.ts`) and are merged into a snapshot's elements. The dylib is loaded only when asked for (the
 * driver option `a11y` or `WARDEN_A11Y=1`); an app launched without it answers `E_UNSUPPORTED` with that hint, never a
 * fabricated value.
 */

/** One entry of the dylib's walk, traversal order. */
export type IosA11yNode = {
	cls: string;
	/** `isAccessibilityElement`: VoiceOver stops on it */
	element: boolean;
	label?: string;
	hint?: string;
	value?: string;
	identifier?: string;
	/** `UIAccessibilityTraits` bitmask (a hex string on the wire: bits above 2^53 do not survive JSON numbers) */
	traits: bigint;
	/** screen points */
	frame: Rect;
	/** `accessibilityCustomActions` names */
	actions: readonly string[];
	/** index in the container's `accessibilityElements`, only when the app set that array */
	order?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

function readNode(value: unknown): IosA11yNode | undefined {
	if (!isRecord(value) || typeof value.ae !== "boolean" || typeof value.cls !== "string") return undefined;
	const { frame, traits, actions } = value;
	if (!Array.isArray(frame) || frame.length !== 4 || !frame.every((n) => typeof n === "number")) return undefined;
	if (typeof traits !== "string" || !/^0x[0-9a-f]+$/i.test(traits)) return undefined;
	if (actions !== undefined && (!Array.isArray(actions) || !actions.every((a) => typeof a === "string"))) {
		return undefined;
	}
	const [x, y, width, height] = frame as number[];
	const label = optionalString(value.label);
	const hint = optionalString(value.hint);
	const text = optionalString(value.value);
	const identifier = optionalString(value.id);
	return {
		cls: value.cls,
		element: value.ae,
		...(label ? { label } : {}),
		...(hint ? { hint } : {}),
		...(text ? { value: text } : {}),
		...(identifier ? { identifier } : {}),
		traits: BigInt(traits),
		frame: { x: x ?? 0, y: y ?? 0, width: width ?? 0, height: height ?? 0 },
		actions: (actions as string[] | undefined) ?? [],
		...(typeof value.order === "number" ? { order: value.order } : {}),
	};
}

/** The dylib's `<state>.a11y` for request `req`, or why it is unusable (the message is for the user). */
export function parseA11yDump(text: string, req: number): Result<IosA11yNode[], string> {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { success: false, error: "the accessibility dump is not JSON" };
	}
	if (!isRecord(data) || data.req !== req) {
		return { success: false, error: "the accessibility dump answers another request" };
	}
	if (typeof data.error === "string")
		return { success: false, error: `the app could not read its tree: ${data.error}` };
	if (data.unsupported === true) return { success: false, error: "the injected library is not iOS: no UIKit to walk" };
	if (!Array.isArray(data.nodes)) return { success: false, error: "the accessibility dump has no nodes" };
	const nodes: IosA11yNode[] = [];
	for (const [index, raw] of data.nodes.entries()) {
		const read = readNode(raw);
		if (!read) return { success: false, error: `the accessibility dump has a malformed node at ${index}` };
		nodes.push(read);
	}
	return { success: true, data: nodes };
}

/** Frames overlapping less than this (intersection over union) are not the same node. */
export const MIN_FRAME_OVERLAP = 0.6;

function overlap(a: Rect, b: Rect): number {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	if (w <= 0 || h <= 0) return 0;
	const inter = w * h;
	const union = a.width * a.height + b.width * b.height - inter;
	return union <= 0 ? 0 : inter / union;
}

function a11yOf(node: IosA11yNode, traversal: number): ElementA11y {
	return {
		...(node.hint ? { hint: node.hint } : {}),
		...(node.actions.length > 0 ? { actions: node.actions } : {}),
		focusable: node.element,
		important: node.element,
		...(node.order === undefined ? {} : { order: node.order }),
		traversal,
	};
}

export type MergedA11y = { snapshot: Snapshot; matched: number; unmatched: number };

/**
 * Merge a walk into a snapshot (a new snapshot; the input is not touched). Rule, applied once per element in
 * document order:
 *  1. identifier: an element with an `identifier` takes the unused node with the same `id` (several: the larger frame
 *     overlap wins);
 *  2. frame: every element still without a node takes the unused node with the largest frame overlap of at least
 *     {@link MIN_FRAME_OVERLAP}, greedily from the best pair down. A node whose `id` is set but different from the
 *     element's identifier never matches by frame.
 * Each node serves one element. Elements with no node keep `a11y` as it was (never invented).
 */
export function mergeA11y(snapshot: Snapshot, nodes: readonly IosA11yNode[]): MergedA11y {
	const used = new Set<number>();
	const picked = new Map<string, number>();
	for (const element of snapshot.flat) {
		const identifier = element.identifier;
		if (!identifier) continue;
		let best = -1;
		let bestOverlap = -1;
		nodes.forEach((node, index) => {
			if (used.has(index) || node.identifier !== identifier) return;
			const score = overlap(element.frame, node.frame);
			if (score > bestOverlap) {
				best = index;
				bestOverlap = score;
			}
		});
		if (best >= 0) {
			used.add(best);
			picked.set(element.id, best);
		}
	}
	const pairs: { element: Element; index: number; score: number }[] = [];
	for (const element of snapshot.flat) {
		if (picked.has(element.id)) continue;
		nodes.forEach((node, index) => {
			if (used.has(index)) return;
			if (node.identifier && node.identifier !== element.identifier) return;
			const score = overlap(element.frame, node.frame);
			if (score >= MIN_FRAME_OVERLAP) pairs.push({ element, index, score });
		});
	}
	pairs.sort((a, b) => b.score - a.score);
	for (const { element, index } of pairs) {
		if (used.has(index) || picked.has(element.id)) continue;
		used.add(index);
		picked.set(element.id, index);
	}
	const flat: Element[] = [];
	const copy = (element: Element): Element => {
		const index = picked.get(element.id);
		const node = index === undefined ? undefined : nodes[index];
		const next: Element = {
			...element,
			...(node && index !== undefined ? { a11y: { ...element.a11y, ...a11yOf(node, index) } } : {}),
			children: [],
		};
		flat.push(next);
		next.children = element.children.map(copy);
		return next;
	};
	const elements = snapshot.elements.map(copy);
	return {
		snapshot: { ...snapshot, elements, flat },
		matched: picked.size,
		unmatched: snapshot.flat.length - picked.size,
	};
}

export type IosA11yDeps = {
	channel: InjectChannel;
	fs?: InjectFs;
	/** the dylib path, resolved on first use so a run that never asks does not look for it */
	dylib: () => Result<string, DriverError>;
	/** was an a11y read asked for (driver option `a11y`, `WARDEN_A11Y=1`) */
	requested: () => boolean;
	debug?: boolean;
	/** how long the app gets to answer a read (default {@link INJECT_ACK_MS}) */
	timeoutMs?: number;
	/** how long a launch gets to load the dylib (default {@link INJECT_LOAD_MS}) */
	loadMs?: number;
};

export type IosA11y = {
	/** Env that loads the dylib (no proxy) when an a11y read was asked for; `undefined`: launch plainly. */
	launchEnv(opts: LaunchOptions): Promise<Result<Record<string, string> | undefined, DriverError>>;
	/** After a launch that carried the dylib: wait until it loaded. */
	confirmLoaded(): DriverResult<void>;
	/** Read the app's UIKit accessibility tree now and merge it into `snapshot`. */
	read(snapshot: Snapshot): DriverResult<Snapshot>;
	/** Announcements and screen/layout notifications the app posted since byte offset `since` (A11Y-8). */
	events(since?: number): DriverResult<A11yEventsRead>;
};

export function createIosA11y(deps: IosA11yDeps): IosA11y {
	const { channel } = deps;
	const fs = deps.fs ?? nodeInjectFs;
	const timeoutMs = deps.timeoutMs ?? INJECT_ACK_MS;
	let expectLoad = false;
	return {
		async launchEnv() {
			if (!deps.requested()) return { success: true, data: undefined };
			const dylib = deps.dylib();
			if (!dylib.success) return dylib;
			channel.reset();
			channel.write({});
			expectLoad = true;
			return {
				success: true,
				data: injectLaunchEnv({
					dylib: dylib.data,
					statePath: channel.statePath,
					...(deps.debug ? { debug: true } : {}),
				}),
			};
		},
		async confirmLoaded() {
			if (!expectLoad) return { success: true, data: undefined };
			expectLoad = false;
			if (await channel.acked(channel.current().seq, deps.loadMs ?? INJECT_LOAD_MS)) {
				return { success: true, data: undefined };
			}
			return {
				success: false,
				error: driverError(
					"E_INTERNAL",
					"the app did not load libwarden-inject.dylib in time, so its accessibility tree cannot be read. Check the app is a simulator build",
					{ detail: { statePath: channel.statePath } }
				),
			};
		},
		async events(since) {
			if (!channel.attached()) {
				return driverErr(
					"E_UNSUPPORTED",
					"announcements come from the injected library, and this app was launched without it: set WARDEN_A11Y=1 (or open the driver with `a11y`) and launch the app again"
				);
			}
			const text = fs.read(injectEventsPath(channel.statePath)) ?? "";
			return { success: true, data: parseInjectEvents(text, since) };
		},
		async read(snapshot) {
			const attached = channel.attached();
			if (!attached) {
				return driverErr(
					"E_UNSUPPORTED",
					"iOS hints, custom actions and order come from the injected library, and this app was launched without it: set WARDEN_A11Y=1 (or open the driver with `a11y`) and launch the app again"
				);
			}
			const { seq: _seq, ...rest } = channel.current();
			const state = channel.write({ ...rest, a11yRead: true });
			if (!(await channel.acked(state.seq, timeoutMs))) {
				return driverErr("E_TIMEOUT", `the app did not answer the accessibility read within ${timeoutMs} ms`, {
					detail: { pid: attached.pid, statePath: channel.statePath },
				});
			}
			const text = fs.read(injectA11yPath(channel.statePath));
			if (text === undefined)
				return driverErr("E_INTERNAL", "the app acknowledged the accessibility read but wrote no dump");
			const parsed = parseA11yDump(text, state.seq);
			if (!parsed.success) return driverErr("E_INTERNAL", parsed.error);
			return { success: true, data: mergeA11y(snapshot, parsed.data).snapshot };
		},
	};
}
