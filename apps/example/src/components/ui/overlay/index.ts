export { Overlay, OverlayProvider, type OverlayProviderProps } from "./overlay";
export {
	OverlayContext,
	type OverlayContextValue,
	TeleportProvidedContext,
	useIsTeleportProvided,
	useOptionalOverlay,
} from "./overlay.context";
export { OVERLAY_MOTION, OVERLAY_SCRIM_TOKEN, type OverlayVariantProps, overlayVariants } from "./overlay.variants";
export type { OverlayPortalProps } from "./overlay-portal";
export { isPresent, type PresenceEvent, type PresencePhase, presenceTarget, reducePresence } from "./overlay-presence";
export {
	INITIAL_OVERLAY_REGISTRY,
	isBelowTopModal,
	isTopOverlay,
	OVERLAY_LAYER_BASE,
	OVERLAY_LAYERS,
	type OverlayLayer,
	type OverlayRegistryAction,
	type OverlayRegistryEntry,
	type OverlayRegistryState,
	reduceOverlayRegistry,
	topModalOverlay,
	topOverlay,
	zIndexOfOverlay,
} from "./overlay-registry";
export type { OverlayScrimProps } from "./overlay-scrim";
export { type UseOverlayBackHandlerOptions, useOverlayBackHandler } from "./use-overlay-back-handler";
export { type OverlayPresence, type UseOverlayPresenceOptions, useOverlayPresence } from "./use-overlay-presence";
