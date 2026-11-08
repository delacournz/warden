import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { isInside, type LatLon } from "../utils/geofence";

export type PermissionState = "undetermined" | "granted" | "denied";

export type GeofenceEvent = { kind: "enter" | "exit"; at: string };

export type PositionState = {
	permission: PermissionState;
	position: LatLon | null;
	inside: boolean | null;
	lastEvent: GeofenceEvent | null;
	requestPermission: () => void;
};

const toPermission = (response: Location.LocationPermissionResponse): PermissionState =>
	response.granted ? "granted" : response.canAskAgain ? "undetermined" : "denied";

/**
 * Foreground permission plus a live position (`watchPositionAsync`, 1 s) and the geofence verdict. The enter / exit
 * event is recorded on every change of the verdict, never on the first fix.
 */
export function usePosition(): PositionState {
	const [permission, setPermission] = useState<PermissionState>("undetermined");
	const [position, setPosition] = useState<LatLon | null>(null);
	const [inside, setInside] = useState<boolean | null>(null);
	const [lastEvent, setLastEvent] = useState<GeofenceEvent | null>(null);
	const insideRef = useRef<boolean | null>(null);

	useEffect(() => {
		Location.getForegroundPermissionsAsync().then((response) => setPermission(toPermission(response)));
	}, []);

	const requestPermission = useCallback(() => {
		Location.requestForegroundPermissionsAsync().then((response) => setPermission(toPermission(response)));
	}, []);

	useEffect(() => {
		if (permission !== "granted") return;
		let subscription: Location.LocationSubscription | undefined;
		let cancelled = false;
		Location.watchPositionAsync(
			{ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
			(fix) => {
				const next = { lat: fix.coords.latitude, lon: fix.coords.longitude };
				const nowInside = isInside(next);
				setPosition(next);
				setInside(nowInside);
				if (insideRef.current !== null && insideRef.current !== nowInside) {
					setLastEvent({ kind: nowInside ? "enter" : "exit", at: new Date().toISOString() });
				}
				insideRef.current = nowInside;
			}
		).then((sub) => {
			if (cancelled) sub.remove();
			else subscription = sub;
		});
		return () => {
			cancelled = true;
			subscription?.remove();
		};
	}, [permission]);

	return { permission, position, inside, lastEvent, requestPermission };
}
