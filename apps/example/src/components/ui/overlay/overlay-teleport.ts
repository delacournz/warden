/**
 * The global flag that says teleport draws an overlay where it is written instead of moving it into
 * the `"root"` host. `react-native-teleport`'s Jest mock does that, and the test kit's `setup.ts`
 * sets this flag to say so.
 *
 * A symbol on `globalThis` rather than an export the test kit imports, so the test kit needs no
 * Overlay to be installed beside it.
 */
export const TELEPORT_INLINE = Symbol.for("delacour.overlay.teleportInline");

/**
 * Whether an overlay draws inside the app content rather than beside it.
 *
 * On a device this is false: teleport moves the overlay into a host next to the app's content
 * `View`, so `OverlayProvider` can hide that `View` from screen readers while a modal is up and the
 * modal stays reachable. When it is true the overlay is inside that `View`, and hiding the view would
 * hide the modal too.
 */
export function isTeleportInline(): boolean {
	return (globalThis as unknown as Record<symbol, unknown>)[TELEPORT_INLINE] === true;
}
