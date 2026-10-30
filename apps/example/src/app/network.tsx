import { IconPause, IconPlay, IconSignalTower, IconWifiNoSignal } from "@/lib/icons/central";
import { SignalGlyph } from "@/modules/network/components/signal-glyph";
import { useNetworkProbes } from "@/modules/network/hooks/use-network-probes";
import { linkText } from "@/modules/network/utils/link-state";
import { countText, lastText, p50Text } from "@/modules/network/utils/samples";
import { EventLog } from "@/modules/showcase/components/event-log";
import { type ActionVariant, Showcase } from "@/modules/showcase/components/showcase";
import { useTones } from "@/modules/showcase/hooks/use-tones";

/**
 * Network control demo on the shared `Showcase` shell, for screen recordings of `warden ui network ...`. One GET to a
 * public HTTPS endpoint every 1.5 s while the screen is open, no retry: the signal glyph lights as many arcs as the
 * measured link allows, the latency strip draws every request, the headline names the state and the readout shows the
 * raw values the specs assert (`net-state`, `net-link`, `net-last`, `net-p50`, `net-count`). Reachable from Settings or
 * `warden-example://network`. iOS only shapes this traffic when the app was launched with warden's network dylib.
 */
export default function NetworkShowcase() {
	const { state, link, samples, tally, events, paused, sent, toggle } = useNetworkProbes();
	const tones = useTones();
	const variant: ActionVariant = paused ? "solid" : "outline";
	const StatusIcon = state.kind === "offline" ? IconWifiNoSignal : IconSignalTower;

	return (
		<Showcase
			backTestID="net-back"
			testID="net-screen"
			title="Network"
			trailing={<StatusIcon color={tones[state.tone]} size={18} />}
		>
			<Showcase.Body>
				<Showcase.Hero
					body={state.body}
					glyph={<SignalGlyph quality={state.quality} samples={samples} sent={sent} tone={state.tone} />}
					title={state.title}
					titleTestID="net-state"
				/>
				<Showcase.Readout>
					<Showcase.Readout.Row label="link" testID="net-link" value={linkText(link)} />
					<Showcase.Readout.Row label="last" testID="net-last" value={lastText(samples.at(-1))} />
					<Showcase.Readout.Row label="p50" testID="net-p50" value={p50Text(samples.slice(-8))} />
					<Showcase.Readout.Row label="count" testID="net-count" value={countText(tally)} />
				</Showcase.Readout>
				<Showcase.Section title="Requests">
					<EventLog empty="Waiting for the first request." lines={events} />
				</Showcase.Section>
			</Showcase.Body>
			<Showcase.Footer>
				<Showcase.Action
					icon={(color) => (paused ? <IconPlay color={color} size={20} /> : <IconPause color={color} size={20} />)}
					label={paused ? "Resume probes" : "Pause probes"}
					onPress={toggle}
					testID="net-toggle"
					variant={variant}
				/>
			</Showcase.Footer>
		</Showcase>
	);
}
