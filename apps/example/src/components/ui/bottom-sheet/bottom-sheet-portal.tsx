import {
	type BottomSheetPortalProps,
	BottomSheet as Headless,
	useOptionalBottomSheetHostName,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { BottomSheetRootHostContext } from "./bottom-sheet-modal.context";

export type PortalDestination = {
	inline: boolean;
	hostName: string | undefined;
	/** The nearest host name, or `null` without a `BottomSheetProvider`. */
	nearest: string | null;
};

/**
 * Whether a portal teleports to the `"root"` host. Mirrors the engine's own
 * rule: it teleports unless `inline` or there is no provider, to `hostName`
 * or else the nearest host.
 */
export function teleportsToRoot({ inline, hostName, nearest }: PortalDestination): boolean {
	if (inline || nearest === null) return false;
	return (hostName ?? nearest) === "root";
}

/**
 * The engine's portal, unchanged, plus one fact for the parts inside it:
 * whether it draws in the `"root"` host. `BottomSheet.Overlay` reads it to
 * decide if it may hide the app from screen readers.
 */
export function BottomSheetPortal(props: BottomSheetPortalProps): ReactElement {
	const nearest = useOptionalBottomSheetHostName();
	const isRootHost = teleportsToRoot({ inline: props.inline ?? false, hostName: props.hostName, nearest });

	return (
		<BottomSheetRootHostContext.Provider value={isRootHost}>
			<Headless.Portal {...props} />
		</BottomSheetRootHostContext.Provider>
	);
}
BottomSheetPortal.displayName = "DelacourUI.BottomSheet.Portal";
