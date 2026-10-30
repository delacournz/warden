import type { Element, ElementA11y, Platform, Rect, Role, Snapshot } from "../driver/driver.types";

type Spec = Partial<Omit<Element, "children" | "frame" | "normFrame" | "depth" | "id">> & {
	frame?: Rect;
	a11y?: ElementA11y;
	children?: Spec[];
};

const SCREENS = {
	ios: { width: 390, height: 844, scale: 3 },
	android: { width: 1080, height: 2400, scale: 2.75 },
} as const;

function build(spec: Spec, id: string, depth: number, platform: Platform): Element {
	const { children = [], frame = { x: 0, y: 0, width: 100, height: 40 }, ...rest } = spec;
	const screen = SCREENS[platform];
	return {
		role: "other" as Role,
		rawType: "Other",
		traits: [],
		enabled: true,
		...rest,
		id,
		frame,
		normFrame: {
			x: frame.x / screen.width,
			y: frame.y / screen.height,
			width: frame.width / screen.width,
			height: frame.height / screen.height,
		},
		depth,
		children: children.map((c, i) => build(c, `${id}.${i}`, depth + 1, platform)),
	};
}

function flatten(els: readonly Element[]): Element[] {
	return els.flatMap((e) => [e, ...flatten(e.children)]);
}

/** Test snapshot from nested specs; ids are preorder paths. */
export function snapshotOf(platform: Platform, specs: Spec[]): Snapshot {
	const elements = specs.map((s, i) => build(s, String(i), 0, platform));
	return {
		platform,
		backend: platform === "ios" ? "axbridge" : "uiautomator",
		takenAt: 0,
		screen: SCREENS[platform],
		elements,
		flat: flatten(elements),
		truncated: false,
	};
}

export function el(platform: Platform, spec: Spec): Element {
	const snap = snapshotOf(platform, [spec]);
	const [first] = snap.elements;
	if (!first) throw new Error("unreachable");
	return first;
}

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

/** Settings screen as XCUI/axbridge reports it (kebab-case traits, switch value "1"/"0"). */
export const IOS_SETTINGS: Snapshot = snapshotOf("ios", [
	{
		role: "window",
		rawType: "Window",
		frame: r(0, 0, 390, 844),
		children: [
			{
				role: "text",
				rawType: "StaticText",
				label: "Settings",
				traits: ["static-text", "header"],
				frame: r(20, 60, 200, 40),
			},
			{
				role: "switch",
				rawType: "Switch",
				label: "Notifications",
				value: "1",
				identifier: "settings-notifications",
				frame: r(20, 120, 350, 44),
				a11y: { hint: "Double tap to toggle", important: true },
			},
			{
				role: "switch",
				rawType: "Switch",
				label: "Dark mode",
				value: "0",
				frame: r(20, 170, 350, 44),
			},
			{ role: "image", rawType: "Image", traits: ["image"], frame: r(20, 230, 48, 48), identifier: "settings-avatar" },
			{
				role: "button",
				rawType: "Button",
				label: "Edit profile",
				traits: ["button"],
				frame: r(20, 290, 350, 44),
				children: [
					{ role: "text", rawType: "StaticText", label: "Edit", frame: r(30, 295, 40, 20) },
					{ role: "text", rawType: "StaticText", label: "profile", frame: r(80, 295, 60, 20) },
				],
			},
			{
				role: "button",
				rawType: "Button",
				label: "Delete account",
				traits: ["button", "not-enabled"],
				enabled: false,
				frame: r(20, 345, 350, 44),
			},
			{
				role: "textfield",
				rawType: "TextField",
				placeholder: "Display name",
				identifier: "settings-name",
				frame: r(20, 400, 350, 44),
			},
			{
				role: "slider",
				rawType: "Slider",
				label: "Volume",
				value: "50%",
				traits: ["adjustable"],
				frame: r(20, 455, 350, 44),
			},
		],
	},
]);

/** Same screen as uiautomator reports it (clickable/checkable/checked flags, descriptions on content-desc). */
export const ANDROID_SETTINGS: Snapshot = snapshotOf("android", [
	{
		role: "other",
		rawType: "android.widget.FrameLayout",
		frame: r(0, 0, 1080, 2400),
		children: [
			{
				role: "text",
				rawType: "android.widget.TextView",
				text: "Settings",
				traits: ["heading"],
				frame: r(40, 160, 500, 100),
			},
			{
				role: "switch",
				rawType: "android.widget.Switch",
				text: "Notifications",
				traits: ["clickable", "checkable", "checked"],
				checked: true,
				frame: r(40, 300, 1000, 120),
				a11y: { hint: "Double tap to toggle", important: true },
			},
			{
				role: "switch",
				rawType: "android.widget.Switch",
				text: "Dark mode",
				traits: ["clickable", "checkable"],
				checked: false,
				frame: r(40, 430, 1000, 120),
			},
			{
				role: "image",
				rawType: "android.widget.ImageView",
				frame: r(40, 580, 130, 130),
				identifier: "settings-avatar",
			},
			{
				role: "button",
				rawType: "android.view.ViewGroup",
				traits: ["clickable"],
				frame: r(40, 740, 1000, 120),
				children: [
					{ role: "text", rawType: "android.widget.TextView", text: "Edit", frame: r(60, 760, 100, 60) },
					{ role: "text", rawType: "android.widget.TextView", text: "profile", frame: r(180, 760, 160, 60) },
				],
			},
			{
				role: "button",
				rawType: "android.widget.Button",
				text: "Delete account",
				traits: ["clickable"],
				enabled: false,
				frame: r(40, 880, 1000, 120),
			},
			{
				role: "textfield",
				rawType: "android.widget.EditText",
				placeholder: "Display name",
				value: "",
				identifier: "settings-name",
				frame: r(40, 1020, 1000, 120),
			},
			{
				role: "other",
				rawType: "android.view.View",
				label: "Hidden decoration",
				a11y: { important: false },
				frame: r(40, 1160, 100, 100),
			},
		],
	},
]);
