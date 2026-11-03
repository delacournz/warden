import type { AppPhase } from "@delacour/warden-core/builds/resolve";

/** The phases that mean the app is not on its way to a device yet, most upstream first. */
const PENDING = ["building", "repacking", "fetching", "waiting"] as const;

/** The first hash segment, 7 chars: a kind hash is `<fingerprint>:<what>`. */
const shortHash = (hash: string): string => (hash.split(":")[0] ?? hash).slice(0, 7);

/**
 * The spinner line for what the sources of an app (a platform's build / repack, each device's install) are doing:
 * the most upstream pending phase wins, so "installing" is only said once nothing is still building, fetching,
 * repacking or waiting. Undefined: nothing worth saying (all ready, or nothing reported yet).
 */
export function appPhaseText(phases: ReadonlyMap<string, AppPhase>): string | undefined {
	const all = [...phases.values()];
	for (const name of PENDING) {
		const found = all.find((p) => p.phase === name);
		if (!found) continue;
		switch (found.phase) {
			case "building":
				return `building the ${found.platform} app (fingerprint ${shortHash(found.hash)})…`;
			case "repacking":
				return "repacking JS into the simulator build…";
			case "fetching":
				return "fetching the EAS build…";
			case "waiting":
				return "waiting for the app build…";
		}
	}
	const installing = all.filter((p) => p.phase === "installing").length;
	return installing > 0 ? `installing the app on ${installing} device(s)…` : undefined;
}

/** Collects the phases of every source and hands each new spinner line to `update`. */
export function phaseTracker(update: (text: string) => void): (source: string, phase: AppPhase) => void {
	const phases = new Map<string, AppPhase>();
	let last: string | undefined;
	return (source, phase) => {
		phases.set(source, phase);
		const text = appPhaseText(phases);
		if (text === undefined || text === last) return;
		last = text;
		update(text);
	};
}
