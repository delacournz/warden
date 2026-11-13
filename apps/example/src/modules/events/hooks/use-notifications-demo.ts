import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState } from "react";

/** Show a notification as a banner even while the app is in front, so a pushed payload is visible on this screen. */
Notifications.setNotificationHandler({
	handleNotification: async () => ({
		shouldShowBanner: true,
		shouldShowList: true,
		shouldPlaySound: false,
		shouldSetBadge: false,
	}),
});

export type NotificationsDemo = {
	/** `unknown` until the first read, then the system's answer: `undetermined`, `granted` or `denied`. */
	status: string;
	/** Title of the last notification delivered to the app, `none` before the first. */
	last: string;
	request: () => void;
};

/**
 * The state behind the events screen: the notification permission (requested only by the button, so a spec or
 * `warden ui permission` decides when the system prompt shows) and the title of the last notification delivered.
 */
export function useNotificationsDemo(): NotificationsDemo {
	const [status, setStatus] = useState("unknown");
	const [last, setLast] = useState("none");

	useEffect(() => {
		let live = true;
		Notifications.getPermissionsAsync().then((p) => live && setStatus(p.status));
		const sub = Notifications.addNotificationReceivedListener((n) => setLast(n.request.content.title ?? "untitled"));
		return () => {
			live = false;
			sub.remove();
		};
	}, []);

	const request = useCallback(() => {
		Notifications.requestPermissionsAsync().then((p) => setStatus(p.status));
	}, []);

	return { status, last, request };
}
