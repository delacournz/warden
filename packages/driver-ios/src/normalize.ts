import type { Element, Rect, ScreenInfo, Snapshot } from "@delacour/warden-driver/driver.types";
import type { SnapshotData, WireElement } from "@delacour/warden-driver/helper/simd-protocol";

/** Wire → `Element`: strips `null`s, fills what the helper may omit (`id` as the preorder path, `depth`, `normFrame`, `traits`, `enabled`, `children`). */
export type Normalized = { elements: Element[]; flat: Element[] };

const STRING_FIELDS = ["label", "identifier", "value", "text", "placeholder"] as const;
const FLAG_FIELDS = ["focused", "hidden", "selected", "checked", "hittable"] as const;

/** Wire to `Element` normalisation and snapshot assembly. Use the shared {@link elementNormalizer} singleton. */
export class ElementNormalizer {
	elements(wire: readonly WireElement[], screen: ScreenInfo, prefix = "", depth = 0): Normalized {
		const flat: Element[] = [];
		const elements = wire.map((node, index) => {
			const path = prefix === "" ? String(index) : `${prefix}.${index}`;
			const element: Element = {
				...this.optionalFields(node),
				id: node.id ?? path,
				role: node.role,
				rawType: node.rawType,
				frame: node.frame,
				depth: node.depth ?? depth,
				normFrame: node.normFrame ?? this.normFrameOf(node.frame, screen),
				traits: node.traits ?? [],
				enabled: node.enabled ?? !(node.traits ?? []).includes("not-enabled"),
				children: [],
			};
			flat.push(element);
			const inner = this.elements(node.children ?? [], screen, path, depth + 1);
			element.children = inner.elements;
			flat.push(...inner.flat);
			return element;
		});
		return { elements, flat };
	}

	/** One element out of `elementAtPoint` (no siblings, so depth/path are 0). */
	element(wire: WireElement, screen: ScreenInfo): Element {
		const [element] = this.elements([wire], screen).elements;
		if (!element) throw new Error("normalizeElement: no element");
		return element;
	}

	snapshot(data: SnapshotData, takenAt: number): Snapshot {
		const { elements, flat } = this.elements(data.elements, data.screen);
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

	private normFrameOf(frame: Rect, screen: ScreenInfo): Rect {
		if (screen.width <= 0 || screen.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
		return {
			x: frame.x / screen.width,
			y: frame.y / screen.height,
			width: frame.width / screen.width,
			height: frame.height / screen.height,
		};
	}

	/** The optional `Element` fields the helper actually set (non-null). */
	private optionalFields(node: WireElement): Partial<Element> {
		const fields: Partial<Element> = {};
		for (const key of STRING_FIELDS) {
			const value = node[key];
			if (typeof value === "string") fields[key] = value;
		}
		for (const key of FLAG_FIELDS) {
			const value = node[key];
			if (typeof value === "boolean") fields[key] = value;
		}
		// a helper built before it reported `is-editing` as focus (one can stay resident for minutes after an upgrade)
		if (node.traits?.includes("is-editing")) fields.focused = true;
		if (node.tapPoint) fields.tapPoint = node.tapPoint;
		if (typeof node.pid === "number") fields.pid = node.pid;
		return fields;
	}
}

export const elementNormalizer = new ElementNormalizer();
