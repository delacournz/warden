/**
 * Whether decorative motion holds still: under the OS reduce-motion setting, or whenever the app
 * asks — `DelacourProvider`'s `isMotionCalm`.
 *
 * The app's half is for automation, not accessibility. A UI test runner that waits for the screen
 * to stop moving before every gesture (Argent waits up to 3 s, Detox and Maestro idle-wait the
 * same way) pays the whole wait on any screen holding a loop that never ends — a shimmering
 * skeleton turns every tap there into a timeout. An E2E build passes `isMotionCalm` and the loops
 * hold still.
 *
 * Only motion that is decoration asks. Motion that *is* the behaviour — a spinner saying work is
 * in flight, a progress bar a reader reads — keeps moving: stilling it would change what the
 * screen says.
 */
export function calmMotion({
	isReduceMotion,
	isMotionCalm,
}: {
	isReduceMotion: boolean;
	isMotionCalm: boolean;
}): boolean {
	return isReduceMotion || isMotionCalm;
}
