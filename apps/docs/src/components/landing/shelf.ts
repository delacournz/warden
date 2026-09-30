import type { Phase } from "@/components/device";

/** Golden clone + boot, as measured: 3.7 s + 11.9 s. */
export const BOOT_SECONDS = 15.6;

export type Slot = {
	name: string;
	udid: string;
	phase: Phase;
	owner: string | null;
	/** Claimed on this page, so `release --mine` may release it. */
	mine: boolean;
	bootElapsed: number;
};

export type Shelf = {
	slots: readonly Slot[];
	/** Owners the next claims are made as. */
	queue: readonly string[];
	notice: string | null;
};

/**
 * An illustrative session on one Mac: two devices already leased by other
 * agents, one warden device booted and free, and one pool slot (`--max 4`)
 * not created yet.
 */
export function initialShelf(): Shelf {
	return {
		slots: [
			{
				name: "warden-iphone-17-1",
				udid: "8F3A2C1E",
				phase: "leased",
				owner: "claude · feature/cowrie",
				mine: false,
				bootElapsed: 0,
			},
			{
				name: "warden-iphone-17-2",
				udid: "41D09B7A",
				phase: "leased",
				owner: "codex · fix/ports",
				mine: false,
				bootElapsed: 0,
			},
			{ name: "warden-iphone-17-3", udid: "C7E51F02", phase: "booted", owner: null, mine: false, bootElapsed: 0 },
			{ name: "warden-iphone-17-4", udid: "—", phase: "empty", owner: null, mine: false, bootElapsed: 0 },
		],
		queue: ["claude · feature/bristleworm", "claude · e2e/checkout", "you · zsh"],
		notice: null,
	};
}

function nextOwner(shelf: Shelf): { owner: string; queue: readonly string[] } {
	const [owner = "you · zsh", ...queue] = shelf.queue;
	return { owner, queue: queue.length > 0 ? queue : ["you · zsh"] };
}

function replace(slots: readonly Slot[], index: number, slot: Slot): readonly Slot[] {
	return slots.map((s, i) => (i === index ? slot : s));
}

/** `warden claim ios`: reuse a free booted device, else clone one from the golden image, else wait. */
export function claim(shelf: Shelf): Shelf {
	const free = shelf.slots.findIndex((s) => s.phase === "booted" && s.owner === null);
	if (free !== -1) {
		const { owner, queue } = nextOwner(shelf);
		const slot = shelf.slots[free];
		return {
			slots: replace(shelf.slots, free, { ...slot, phase: "leased", owner, mine: true }),
			queue,
			notice: `reused ${slot.name}, already booted → ${owner}`,
		};
	}

	const empty = shelf.slots.findIndex((s) => s.phase === "empty");
	if (empty !== -1) {
		const { owner, queue } = nextOwner(shelf);
		const slot = shelf.slots[empty];
		return {
			slots: replace(shelf.slots, empty, {
				...slot,
				udid: "E29B7D44",
				phase: "booting",
				owner,
				mine: true,
				bootElapsed: 0,
			}),
			queue,
			notice: `cloning ${slot.name} from the golden image → ${owner}`,
		};
	}

	return { ...shelf, notice: "every warden-iphone-17 device is leased (--max 4); claim waits for a release" };
}

/** Advance booting devices by `seconds`; a finished boot hands the device to its owner. */
export function tick(shelf: Shelf, seconds: number): Shelf {
	return {
		...shelf,
		slots: shelf.slots.map((s) => {
			if (s.phase !== "booting") return s;
			const bootElapsed = Math.min(BOOT_SECONDS, s.bootElapsed + seconds);
			return { ...s, bootElapsed, phase: bootElapsed >= BOOT_SECONDS ? "leased" : "booting" };
		}),
	};
}

/** `warden release --mine`: drop my leases; the devices stay booted for the next claim. */
export function release(shelf: Shelf): Shelf {
	const count = shelf.slots.filter((s) => s.mine && s.phase === "leased").length;
	return {
		...shelf,
		slots: shelf.slots.map((s) =>
			s.mine && s.phase === "leased" ? { ...s, phase: "booted", owner: null, mine: false } : s
		),
		notice:
			count > 0
				? `released ${count} lease${count === 1 ? "" : "s"}; devices stay booted for reuse`
				: "nothing of yours to release",
	};
}
