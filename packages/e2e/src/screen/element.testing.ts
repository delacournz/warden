import type { Element, Platform, Role, ScreenInfo, Snapshot } from "../driver/driver.types";

const SCREEN: ScreenInfo = { width: 390, height: 844, scale: 3 };

export type ElementProps = Partial<Omit<Element, "role" | "children" | "depth">>;

/** A plain `Element` for tests; ids and depths are assigned by `snap()`. */
export function el(role: Role, props: ElementProps = {}, children: Element[] = []): Element {
	return {
		id: "?",
		role,
		rawType: role,
		frame: { x: 0, y: 0, width: 100, height: 40 },
		normFrame: { x: 0, y: 0, width: 100 / SCREEN.width, height: 40 / SCREEN.height },
		traits: [],
		enabled: true,
		depth: 0,
		children,
		...props,
	};
}

function assign(elements: Element[], depth: number, prefix: string, flat: Element[]): void {
	elements.forEach((element, position) => {
		element.depth = depth;
		if (element.id === "?") element.id = `${prefix}${position}`;
		flat.push(element);
		assign(element.children, depth + 1, `${element.id}.`, flat);
	});
}

/** Wraps a tree into a `Snapshot`: preorder `flat`, depths and `0.1.2` ids filled in where `el()` left defaults. */
export function snap(elements: Element[], options: { platform?: Platform; screen?: ScreenInfo } = {}): Snapshot {
	const flat: Element[] = [];
	assign(elements, 0, "", flat);
	const platform = options.platform ?? "ios";
	return {
		platform,
		backend: platform === "ios" ? "axbridge" : "uiautomator",
		takenAt: 0,
		screen: options.screen ?? SCREEN,
		elements,
		flat,
		truncated: false,
	};
}
