import { useThemeColor } from "@/hooks/use-theme-color";
import { IconEraser, IconLocation, IconMapPin } from "@/lib/icons/central";
import { TrackGlyph } from "@/modules/location/components/track-glyph";
import { useLocationTrack } from "@/modules/location/hooks/use-location-track";
import { distanceMeters, formatDistance, formatSpeed } from "@/modules/location/utils/geo";
import { describeTrack } from "@/modules/location/utils/track";
import { EventLog } from "@/modules/showcase/components/event-log";
import { type ActionVariant, Showcase } from "@/modules/showcase/components/showcase";
import type { Tone } from "@/modules/showcase/utils/tones";

const ICON_TONE_VARIABLE = {
	idle: "tertiary-foreground",
	scan: "info",
	open: "success",
	warn: "warning",
	off: "tertiary-foreground",
} as const satisfies Record<Tone, string>;

/**
 * Location control demo on the shared `Showcase` shell, for screen recordings: the live track draws from the GPS fixes
 * `expo-location` delivers (`warden ui location set | route | scenario`), the dashed ring is a 150 m geofence around the
 * first fix, and the readout shows the raw values specs assert (`loc-state`, `loc-coords`, `loc-speed`, `loc-distance`,
 * `loc-fixes`, `loc-geofence`). Reachable from Settings or `warden-example://location` (no sign-in gate). The main
 * button starts tracking, then clears the track while the watch keeps running.
 */
export default function LocationShowcase() {
	const { state, start, clear } = useLocationTrack();
	const description = describeTrack(state);
	const iconColor = useThemeColor(ICON_TONE_VARIABLE[description.tone]);

	const { last, origin, tracking } = state;
	const distance = last && origin ? formatDistance(distanceMeters(origin, last)) : "-";
	const coords = last ? `${last.lat.toFixed(5)}, ${last.lon.toFixed(5)}` : "-";
	const geofence = state.inside === null ? "-" : state.inside ? "Inside" : "Outside";
	const variant: ActionVariant = tracking ? "outline" : "solid";

	return (
		<Showcase
			backTestID="loc-back"
			testID="loc-screen"
			title="Location"
			trailing={<IconLocation color={iconColor} size={18} />}
		>
			<Showcase.Body>
				<Showcase.Hero
					body={description.body}
					glyph={
						<TrackGlyph
							origin={origin}
							ringTone={state.inside === null ? "idle" : state.inside ? "open" : "warn"}
							track={state.track}
						/>
					}
					title={description.title}
					titleTestID="loc-state"
				/>
				<Showcase.Readout>
					<Showcase.Readout.Row label="coords" testID="loc-coords" value={coords} />
					<Showcase.Readout.Row label="speed" testID="loc-speed" value={formatSpeed(state.speed)} />
					<Showcase.Readout.Row label="distance" testID="loc-distance" value={distance} />
					<Showcase.Readout.Row label="fixes" testID="loc-fixes" value={String(state.count)} />
					<Showcase.Readout.Row label="geofence" testID="loc-geofence" value={geofence} />
				</Showcase.Readout>
				<Showcase.Section title="Fixes">
					<EventLog empty="no fixes yet" lines={state.events} />
				</Showcase.Section>
			</Showcase.Body>
			<Showcase.Footer>
				<Showcase.Action
					icon={(color) => (tracking ? <IconEraser color={color} size={20} /> : <IconMapPin color={color} size={20} />)}
					label={tracking ? "Clear track" : "Start tracking"}
					onPress={tracking ? clear : start}
					testID="loc-toggle"
					variant={variant}
				/>
			</Showcase.Footer>
		</Showcase>
	);
}
