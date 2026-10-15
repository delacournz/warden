import type { Element, Rect, ScreenInfo, Snapshot } from "../driver.types";
import type { SnapshotData, WireElement } from "./simd-protocol";

/** Wire → `Element`: fills what the helper may omit (`id` as the preorder path, `depth`, `normFrame`, `traits`, `enabled`, `children`). */
export type Normalized = { elements: Element[]; flat: Element[] };

function normFrameOf(frame: Rect, screen: ScreenInfo): Rect {
	if (screen.width <= 0 || screen.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
	return {
		x: frame.x / screen.width,
		y: frame.y / screen.height,
		width: frame.width / screen.width,
		height: frame.height / screen.height,
	};
}

export function normalizeElements(
	wire: readonly WireElement[],
	screen: ScreenInfo,
	prefix = "",
	depth = 0
): Normalized {
	const flat: Element[] = [];
	const elements = wire.map((node, index) => {
		const path = prefix === "" ? String(index) : `${prefix}.${index}`;
		const { children: wireChildren, ...rest } = node;
		const element: Element = {
			...rest,
			id: node.id ?? path,
			depth: node.depth ?? depth,
			normFrame: node.normFrame ?? normFrameOf(node.frame, screen),
			traits: node.traits ?? [],
			enabled: node.enabled ?? true,
			children: [],
		};
		flat.push(element);
		const inner = normalizeElements(wireChildren ?? [], screen, path, depth + 1);
		element.children = inner.elements;
		flat.push(...inner.flat);
		return element;
	});
	return { elements, flat };
}

/** One element out of `elementAtPoint` (no siblings, so depth/path are 0). */
export function normalizeElement(wire: WireElement, screen: ScreenInfo): Element {
	const [element] = normalizeElements([wire], screen).elements;
	if (!element) throw new Error("normalizeElement: no element");
	return element;
}

export function toSnapshot(data: SnapshotData, takenAt: number): Snapshot {
	const { elements, flat } = normalizeElements(data.elements, data.screen);
	const snapshot: Snapshot = {
		platform: "ios",
		backend: data.backend,
		takenAt,
		screen: data.screen,
		elements,
		flat,
		truncated: data.truncated,
	};
	if (data.modal) snapshot.modal = data.modal;
	return snapshot;
}
