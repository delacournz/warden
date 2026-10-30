import { Showcase } from "@/modules/showcase/components/showcase";

/** Placeholder for the clock showcase (WDN-SHOW). */
export default function ClockShowcase() {
	return (
		<Showcase backTestID="clk-back" testID="clk-screen" title="Clock">
			<Showcase.Body>{null}</Showcase.Body>
		</Showcase>
	);
}
