import type { Logger } from "../driver.types";
import type { AdbSession } from "./adb-session";
import {
	type AnimationValues,
	animationReadArgvs,
	animationRestoreArgvs,
	animationScaleArgvs,
	shellCommand,
} from "./android-argv";
import { type AndroidStateStore, parseAnimationValues, patchFor, planAnimations } from "./android-state";

/**
 * Animations off for the run (a flake source in e2e) and back on afterwards. The three scales are global
 * settings that outlive the driver, so whatever warden changes it puts back when the driver closes, and the
 * values it will put back are saved with the device's state (`android-state.ts`) before anything can go wrong:
 * a process that dies without closing leaves the originals in the file, and the next driver opened on that
 * emulator restores them when it closes.
 */

export type AnimationGuard = {
	/** put the scales back (once); a restore that fails leaves the saved originals for the next driver */
	restore(): Promise<void>;
};

export type AnimationDeps = {
	session: AdbSession;
	serial: string;
	sdk: number | undefined;
	/** originals a process that died left in the state file, if any */
	pending: AnimationValues | undefined;
	state?: AndroidStateStore;
	log?: Logger;
};

const sameValues = (a: AnimationValues | undefined, b: AnimationValues | undefined): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

/**
 * One shell round trip that reads the three scales and sets them to 0, then (when something has to be put
 * back) saves the originals. Never fails the open: a device that refuses just keeps its animations.
 */
export async function disableAnimations(deps: AnimationDeps): Promise<AnimationGuard> {
	const { session, serial, sdk, state, log } = deps;
	const command = [...animationReadArgvs(), ...animationScaleArgvs()].map((argv) => shellCommand(argv)).join("; ");
	let restorable = deps.pending;
	const ran = await session.run(command);
	if (!ran.success || ran.data.exitCode !== 0) {
		log?.("could not disable animations");
	} else {
		const found = parseAnimationValues(ran.data.stdout);
		if (found === undefined) log?.("could not read the animation scales, so they will not be restored");
		else restorable = planAnimations(found, deps.pending);
	}
	if (state && !sameValues(restorable, deps.pending)) {
		await state.update(serial, patchFor(sdk, { animations: restorable }));
	}

	return {
		async restore() {
			const originals = restorable;
			if (originals === undefined) return;
			restorable = undefined;
			const put = await session.run(
				animationRestoreArgvs(originals)
					.map((argv) => shellCommand(argv))
					.join("; ")
			);
			if (!put.success || put.data.exitCode !== 0) {
				log?.("could not restore the animation scales; the next driver on this device will");
				return;
			}
			await state?.update(serial, patchFor(sdk, { animations: undefined }));
		},
	};
}
