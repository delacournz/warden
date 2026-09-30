import { type ReactElement, useEffect, useReducer, useRef } from "react";
import { DeviceFrame, PHASE_LABEL, PhaseGlyph } from "@/components/device";
import { cn } from "@/lib/cn";
import { BOOT_SECONDS, claim, initialShelf, release, type Shelf, type Slot, tick } from "./shelf";

/** Boots replay at this multiple of real time; the timer still reads measured seconds. */
const REPLAY_SPEED = 4;

type Action = { type: "claim" } | { type: "release" } | { type: "tick"; seconds: number };

function reducer(shelf: Shelf, action: Action): Shelf {
	switch (action.type) {
		case "claim":
			return claim(shelf);
		case "release":
			return release(shelf);
		case "tick":
			return tick(shelf, action.seconds);
	}
}

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The signature interaction: warden's own device shelf. On load one agent's
 * claim reuses the free booted sim and the next clones a new one from the
 * golden image, its boot counted in measured seconds. The reader can keep
 * claiming until the pool hits `--max`, then release their own leases —
 * other agents' devices are never touched.
 *
 * The phone-width rack carries `contain: paint`: without it mobile Chrome
 * widens the layout viewport to the rack's scroll width even though it clips.
 */
export function DeviceShelf(): ReactElement {
	const [shelf, dispatch] = useReducer(reducer, undefined, initialShelf);
	const booting = shelf.slots.some((s) => s.phase === "booting");
	const last = useRef<number | null>(null);
	const rack = useRef<HTMLUListElement>(null);
	const bootingName = shelf.slots.find((s) => s.phase === "booting")?.name;

	useEffect(() => {
		const ul = rack.current;
		if (!bootingName || !ul || ul.scrollWidth <= ul.clientWidth) return;
		const item = ul.querySelector<HTMLElement>(`[data-slot="${bootingName}"]`);
		if (!item) return;
		ul.scrollTo({
			left: item.offsetLeft - (ul.clientWidth - item.clientWidth) / 2,
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
	}, [bootingName]);

	useEffect(() => {
		const first = window.setTimeout(() => dispatch({ type: "claim" }), 900);
		const second = window.setTimeout(() => dispatch({ type: "claim" }), 2100);
		return () => {
			window.clearTimeout(first);
			window.clearTimeout(second);
		};
	}, []);

	useEffect(() => {
		if (!booting) {
			last.current = null;
			return;
		}
		if (prefersReducedMotion()) {
			dispatch({ type: "tick", seconds: BOOT_SECONDS });
			return;
		}
		let frame = 0;
		const step = (now: number) => {
			const dt = last.current === null ? 0 : (now - last.current) / 1000;
			last.current = now;
			dispatch({ type: "tick", seconds: dt * REPLAY_SPEED });
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [booting]);

	return (
		<section aria-label="Example device shelf" className="rounded-[22px] bg-surface p-4 sm:p-5">
			<ul
				className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto [contain:paint] sm:[contain:none] relative scroll-px-[11%] px-[11%] pb-2 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0 sm:scroll-px-0"
				ref={rack}
			>
				{shelf.slots.map((slot) => (
					<DeviceUnit key={slot.name} slot={slot} />
				))}
			</ul>
			<div className="mt-4 flex flex-col gap-3 border-hairline border-t pt-4 sm:flex-row sm:items-center">
				<div className="flex gap-2">
					<button
						className="rounded-full bg-lease px-4 py-2 font-medium font-mono text-lease-ink text-sm transition-[filter] hover:brightness-110 active:brightness-95"
						onClick={() => dispatch({ type: "claim" })}
						type="button"
					>
						warden claim ios
					</button>
					<button
						className="rounded-full bg-fill px-4 py-2 font-medium font-mono text-ink text-sm transition-colors hover:bg-hairline"
						onClick={() => dispatch({ type: "release" })}
						type="button"
					>
						release --mine
					</button>
				</div>
				<p aria-live="polite" className="min-h-5 font-mono text-ink-2 text-xs sm:ms-auto sm:text-right">
					{shelf.notice ?? ""}
				</p>
			</div>
			<p className="mt-3 text-ink-2 text-xs">
				Illustrative session: owners and udids are examples. Boots replay at 4×; the timer reads measured seconds.
			</p>
		</section>
	);
}

function DeviceUnit({ slot }: { slot: Slot }): ReactElement {
	const progress = slot.bootElapsed / BOOT_SECONDS;
	const showTimer = slot.phase === "booting" || (slot.mine && slot.bootElapsed > 0);

	return (
		<li className="flex w-[78%] shrink-0 snap-center flex-col gap-3 sm:w-auto" data-slot={slot.name}>
			<div className="relative">
				<DeviceFrame
					className={cn(
						"mx-auto h-auto w-full max-w-[112px] transition-opacity",
						slot.phase === "empty" && "opacity-80"
					)}
					phase={slot.phase}
					progress={progress}
				/>
				{showTimer ? (
					<p
						className={cn(
							"-translate-x-1/2 -translate-y-1/2 absolute top-[73.8%] left-1/2 rounded-md px-1.5 font-medium font-mono text-2xl tabular-nums tracking-tight",
							slot.phase === "booting"
								? "text-[#f5f5f7]"
								: "bg-[#f2f2f7]/90 text-[#1c1c1e] dark:bg-[#2c2c2e]/90 dark:text-[#f5f5f7]"
						)}
					>
						{slot.bootElapsed.toFixed(1)}
						<span className="ms-0.5 text-sm">s</span>
					</p>
				) : null}
			</div>
			<dl className="divide-y divide-hairline overflow-hidden rounded-xl bg-ground text-xs">
				<div className="px-3 py-2">
					<dt className="sr-only">Device</dt>
					<dd className="truncate font-medium font-mono text-ink">{slot.name}</dd>
					<dd className="font-mono text-ink-2">udid {slot.udid}</dd>
				</div>
				<div className="flex items-center gap-2 px-3 py-2">
					<dt className="sr-only">State</dt>
					<PhaseGlyph className={slot.phase === "leased" ? undefined : "text-ink-2"} phase={slot.phase} />
					<dd className={cn("font-medium", slot.phase === "leased" ? "text-ink" : "text-ink-2")}>
						{PHASE_LABEL[slot.phase]}
					</dd>
				</div>
				<div className="px-3 py-2">
					<dt className="sr-only">Owner</dt>
					<dd className={cn("truncate font-mono", slot.owner ? "text-ink" : "text-ink-2")}>
						{slot.owner ?? "no lease"}
					</dd>
				</div>
			</dl>
		</li>
	);
}
