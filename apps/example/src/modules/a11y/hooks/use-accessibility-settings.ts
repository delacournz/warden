import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export type AccessibilitySettings = {
	screenReader: boolean;
	reduceMotion: boolean;
	boldText: boolean;
};

type SettingKey = keyof AccessibilitySettings;

/** Each setting's initial read and its change event, so one loop wires all three. */
const SOURCES: Record<
	SettingKey,
	{ read: () => Promise<boolean>; event: "screenReaderChanged" | "reduceMotionChanged" | "boldTextChanged" }
> = {
	screenReader: { read: () => AccessibilityInfo.isScreenReaderEnabled(), event: "screenReaderChanged" },
	reduceMotion: { read: () => AccessibilityInfo.isReduceMotionEnabled(), event: "reduceMotionChanged" },
	boldText: { read: () => AccessibilityInfo.isBoldTextEnabled(), event: "boldTextChanged" },
};

const KEYS = Object.keys(SOURCES) as SettingKey[];

/** The live OS accessibility settings the app can read: initial value plus a listener per setting. */
export function useAccessibilitySettings(): AccessibilitySettings {
	const [settings, setSettings] = useState<AccessibilitySettings>({
		screenReader: false,
		reduceMotion: false,
		boldText: false,
	});

	useEffect(() => {
		let active = true;
		const set = (key: SettingKey, value: boolean) => {
			if (active) setSettings((prev) => ({ ...prev, [key]: value }));
		};
		const subscriptions = KEYS.map((key) => {
			const { read, event } = SOURCES[key];
			read().then((value) => set(key, value));
			return AccessibilityInfo.addEventListener(event, (value) => set(key, value));
		});
		return () => {
			active = false;
			for (const subscription of subscriptions) subscription.remove();
		};
	}, []);

	return settings;
}
