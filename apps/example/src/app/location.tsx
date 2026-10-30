import { Showcase } from "@/modules/showcase/components/showcase";

/** Placeholder for the location showcase (WDN-SHOW). */
export default function LocationShowcase() {
	return (
		<Showcase backTestID="loc-back" testID="loc-screen" title="Location">
			<Showcase.Body>{null}</Showcase.Body>
		</Showcase>
	);
}
