import * as Location from "expo-location";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { initialTrack, type PermissionState, type TrackState, trackReducer } from "../utils/track";

const toPermission = (response: Location.LocationPermissionResponse): PermissionState =>
	response.granted ? "granted" : response.canAskAgain ? "undetermined" : "denied";

/**
 * Live GPS track over `expo-location`. The permission is read on mount; `start` asks for it and, when granted, watches
 * the position (`watchPositionAsync`, high accuracy, 1 s, no distance filter) until the screen unmounts. `clear` keeps
 * the watch running and drops the track, so the next fix becomes the geofence centre. Event times are milliseconds
 * since the screen mounted.
 */
export function useLocationTrack(): { state: TrackState; start: () => Promise<void>; clear: () => void } {
	const [state, dispatch] = useReducer(trackReducer, initialTrack);
	const mountedAt = useRef(Date.now());
	const since = useCallback(() => Date.now() - mountedAt.current, []);

	useEffect(() => {
		let cancelled = false;
		Location.getForegroundPermissionsAsync().then((response) => {
			if (!cancelled) dispatch({ type: "permission", permission: toPermission(response), at: since() });
		});
		return () => {
			cancelled = true;
		};
	}, [since]);

	const start = useCallback(async () => {
		const response = await Location.requestForegroundPermissionsAsync();
		const permission = toPermission(response);
		dispatch({ type: "permission", permission, at: since() });
		if (permission === "granted") dispatch({ type: "started", at: since() });
	}, [since]);

	const clear = useCallback(() => dispatch({ type: "cleared", at: since() }), [since]);

	const { tracking } = state;
	useEffect(() => {
		if (!tracking) return;
		let subscription: Location.LocationSubscription | undefined;
		let cancelled = false;
		Location.watchPositionAsync(
			{ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
			(fix) => {
				dispatch({
					type: "fix",
					at: since(),
					fix: {
						lat: fix.coords.latitude,
						lon: fix.coords.longitude,
						timestamp: fix.timestamp,
						speed: fix.coords.speed,
					},
				});
			}
		).then((sub) => {
			if (cancelled) sub.remove();
			else subscription = sub;
		});
		return () => {
			cancelled = true;
			subscription?.remove();
		};
	}, [tracking, since]);

	return { state, start, clear };
}
