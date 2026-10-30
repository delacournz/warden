import { IconClock } from "@/lib/icons/central";
import { TrialDial } from "@/modules/clock/components/trial-dial";
import { useTrialClock } from "@/modules/clock/hooks/use-trial-clock";
import { formatDay, formatOffset, trialCopy } from "@/modules/clock/utils/trial-view";
import { EventLog } from "@/modules/showcase/components/event-log";
import { Showcase } from "@/modules/showcase/components/showcase";
import { useTones } from "@/modules/showcase/hooks/use-tones";

/** The device clock as an ISO time without milliseconds: `2026-10-30T09:41:03Z`. */
function isoSeconds(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Clock showcase for screen recordings: a 14-day trial whose dial reads the device wall clock. `warden ui clock
 * advance 10d` takes ten days off the dial in one sweep, `advance 5d` expires the trial, `clock reset` brings it back.
 * The trial starts when this launch's JS did (the conditions screen's rule), so the clock moves relative to a fixed
 * start. The readout shows what the specs assert (`clk-*`); `clk-offset` is the wall clock against the screen's own
 * monotonic clock, which proves the clock moved while real time did not. The screen makes no network call: a large
 * offset breaks HTTPS. Reachable from Settings or `warden-example://clock`.
 */
export default function ClockShowcase() {
	const { now, start, state, offsetMs, events, restart } = useTrialClock();
	const tones = useTones();
	const copy = trialCopy(state, start);
	const expired = state.kind === "expired";

	return (
		<Showcase
			backTestID="clk-back"
			testID="clk-screen"
			title="Clock"
			trailing={<IconClock color={expired ? tones.warn : tones.open} size={18} />}
		>
			<Showcase.Body>
				<Showcase.Hero
					body={copy.body}
					glyph={<TrialDial state={state} />}
					title={copy.title}
					titleTestID="clk-state"
				/>
				<Showcase.Readout>
					<Showcase.Readout.Row label="now" testID="clk-now" value={isoSeconds(now)} />
					<Showcase.Readout.Row label="started" testID="clk-started" value={formatDay(start)} />
					<Showcase.Readout.Row
						label="days left"
						testID="clk-days"
						value={String(state.kind === "active" ? state.daysLeft : 0)}
					/>
					<Showcase.Readout.Row label="trial" testID="clk-trial" value={expired ? "Expired" : "Active"} />
					<Showcase.Readout.Row label="offset" testID="clk-offset" value={formatOffset(offsetMs)} />
				</Showcase.Readout>
				<Showcase.Section title="Clock">
					<EventLog empty="no events yet" lines={events} />
				</Showcase.Section>
			</Showcase.Body>
			<Showcase.Footer>
				<Showcase.Action label="Restart trial" onPress={restart} testID="clk-restart" variant="outline" />
			</Showcase.Footer>
		</Showcase>
	);
}
