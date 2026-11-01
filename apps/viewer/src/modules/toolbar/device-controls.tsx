import { DeviceMobile, DeviceMobileSpeaker, House, MapPin, Vibrate } from "@phosphor-icons/react";
import { useState } from "react";
import type { DeviceActions, Orientation } from "../interaction/device-actions.ts";
import { LocationDialog } from "../interaction/dialogs.tsx";
import { IconButton } from "./icon-button.tsx";

type DeviceControlsProps = {
	actions: DeviceActions;
	disabledReason: string | null;
};

/**
 * Home, shake, rotate and set-location buttons for the toolbar. Rotate toggles between portrait
 * and landscape and sends the new orientation; Set location opens a dialog. Each is disabled with a
 * reason while the stream is not live, like the other device actions.
 */
export function DeviceControls({ actions, disabledReason }: DeviceControlsProps) {
	const [orientation, setOrientation] = useState<Orientation>("portrait");
	const [locationOpen, setLocationOpen] = useState(false);
	const next: Orientation = orientation === "portrait" ? "landscape" : "portrait";

	return (
		<>
			<IconButton label="Home" onClick={() => actions.goHome({})} disabledReason={disabledReason}>
				<House />
			</IconButton>
			<IconButton label="Shake" onClick={() => actions.shake({})} disabledReason={disabledReason}>
				<Vibrate />
			</IconButton>
			<IconButton
				label={`Rotate to ${next}`}
				onClick={() => {
					setOrientation(next);
					actions.setOrientation({ orientation: next });
				}}
				disabledReason={disabledReason}
			>
				{orientation === "portrait" ? <DeviceMobile /> : <DeviceMobileSpeaker className="rotate-90" />}
			</IconButton>
			<IconButton label="Set location…" onClick={() => setLocationOpen(true)} disabledReason={disabledReason}>
				<MapPin />
			</IconButton>
			<LocationDialog open={locationOpen} onOpenChange={setLocationOpen} onSubmit={(c) => actions.setLocation(c)} />
		</>
	);
}
