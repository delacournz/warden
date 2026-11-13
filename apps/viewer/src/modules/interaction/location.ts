export type Coordinates = { latitude: number; longitude: number };
export type LocationPreset = Coordinates & { name: string };

export const LOCATION_PRESETS: readonly LocationPreset[] = [
	{ name: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
	{ name: "New York", latitude: 40.7128, longitude: -74.006 },
	{ name: "London", latitude: 51.5074, longitude: -0.1278 },
	{ name: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
	{ name: "Sydney", latitude: -33.8688, longitude: 151.2093 },
	{ name: "Berlin", latitude: 52.52, longitude: 13.405 },
];

function parseIn(text: string, limit: number): number | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const value = Number(trimmed);
	return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/** Latitude within ±90 and longitude within ±180, or null if either field is not a valid number. */
export function parseLocation(latitude: string, longitude: string): Coordinates | null {
	const lat = parseIn(latitude, 90);
	const lng = parseIn(longitude, 180);
	return lat === null || lng === null ? null : { latitude: lat, longitude: lng };
}
