import { IconFaceId, IconLock } from "@central-icons-react-native/round-outlined-radius-1-stroke-1.5";
import { useThemeColor } from "@/hooks/use-theme-color";
import { AttemptLog } from "@/modules/biometrics/components/attempt-log";
import { FaceGlyph } from "@/modules/biometrics/components/face-glyph";
import { VaultDrawer } from "@/modules/biometrics/components/vault-drawer";
import { useBiometricUnlock } from "@/modules/biometrics/hooks/use-biometric-unlock";
import { copyOf } from "@/modules/biometrics/utils/vault-theme";
import { type ActionVariant, Showcase } from "@/modules/showcase/components/showcase";

/**
 * Biometric unlock demo, styled as a vault in the app's docs palette (light and dark) for screen recordings, on the
 * shared `Showcase` shell: the face-frame glyph carries the state, the readout shows the raw `status` / `error` the
 * specs assert on (`bio-status`, `bio-error`), the attempt log timestamps every try and the contents drawer rises on
 * unlock. Reachable from Settings or `warden-example://biometrics` (no sign-in gate). The main button unlocks, or
 * locks the vault again once it is open.
 */
export default function Biometrics() {
	const { status, error, events, unlock, lock } = useBiometricUnlock();
	const success = useThemeColor("success");
	const faint = useThemeColor("tertiary-foreground");

	const latestMatch = events.find((e) => e.kind === "unlocked");
	const copy = copyOf(status, latestMatch?.kind === "unlocked" ? latestMatch.tookMs : undefined);
	const isOpen = status === "Unlocked";
	const isBusy = status === "Scanning" || status === "Checking";
	const variant: ActionVariant = isOpen ? "outline" : isBusy ? "busy" : "solid";
	const actionLabel = isOpen ? "Lock vault" : isBusy ? "Scanning…" : "Unlock with Face ID";

	return (
		<Showcase
			backTestID="bio-back"
			testID="bio-screen"
			title="Vault"
			trailing={<IconLock color={isOpen ? success : faint} size={18} />}
		>
			<Showcase.Body>
				<Showcase.Hero body={copy.body} glyph={<FaceGlyph status={status} />} title={copy.title} />
				<Showcase.Readout>
					<Showcase.Readout.Row label="status" testID="bio-status" value={status} />
					<Showcase.Readout.Row label="error" testID="bio-error" value={error} />
				</Showcase.Readout>
				{isOpen && <VaultDrawer />}
				<Showcase.Section title="Attempts">
					<AttemptLog events={events} />
				</Showcase.Section>
			</Showcase.Body>
			<Showcase.Footer>
				<Showcase.Action
					icon={isOpen ? undefined : (color) => <IconFaceId color={color} size={20} />}
					label={actionLabel}
					onPress={isOpen ? lock : unlock}
					testID="bio-unlock"
					variant={variant}
				/>
			</Showcase.Footer>
		</Showcase>
	);
}
