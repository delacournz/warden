import { useThemeColor } from "@/hooks/use-theme-color";
import { IconPasskeys } from "@/lib/icons/central";
import { KeyGlyph } from "@/modules/passkeys/components/key-glyph";
import { PasskeyLog } from "@/modules/passkeys/components/passkey-log";
import { RP_ID, usePasskey } from "@/modules/passkeys/hooks/use-passkey";
import { actionOf, copyOf, shortId, tookMsOf } from "@/modules/passkeys/utils/passkey-state";
import { Showcase } from "@/modules/showcase/components/showcase";

/**
 * Passkey demo on the shared `Showcase` shell, for screen recordings and the passkeys spec: the key glyph carries the
 * state (its teeth are cut from the real credential id), the readout shows the raw values the specs assert on
 * (`pk-status`, `pk-error`, `pk-rp`, `pk-credential`, `pk-uv`, `pk-sign-count`, `pk-origin`), the log timestamps every
 * call. The one action creates a passkey, then signs in with it (the screen verifies the signature itself), then signs
 * out. Reachable from Settings or `warden-example://passkeys` (no sign-in gate).
 */
export default function Passkeys() {
	const { status, error, registration, assertion, events, create, signIn, signOut } = usePasskey();
	const success = useThemeColor("success");
	const faint = useThemeColor("tertiary-foreground");

	const copy = copyOf(status, { tookMs: tookMsOf(status, events), error });
	const action = actionOf(status, registration !== undefined);
	const onPress = action.kind === "create" ? create : action.kind === "sign-in" ? signIn : signOut;
	const uv = assertion?.userVerified ?? registration?.userVerified;
	const signCount = assertion?.signCount ?? registration?.signCount;
	const origin = assertion?.origin ?? registration?.origin;

	return (
		<Showcase
			backTestID="pk-back"
			testID="pk-screen"
			title="Passkeys"
			trailing={<IconPasskeys color={status === "Signed in" ? success : faint} size={18} />}
		>
			<Showcase.Body>
				<Showcase.Hero
					body={copy.body}
					glyph={<KeyGlyph credentialId={registration?.credentialId} status={status} />}
					title={copy.title}
					titleTestID="pk-title"
				/>
				<Showcase.Readout>
					<Showcase.Readout.Row label="status" testID="pk-status" value={status} />
					<Showcase.Readout.Row label="error" testID="pk-error" value={error} />
					<Showcase.Readout.Row label="rp" testID="pk-rp" value={RP_ID} />
					<Showcase.Readout.Row label="credential" testID="pk-credential" value={shortId(registration?.credentialId)} />
					<Showcase.Readout.Row label="uv" testID="pk-uv" value={uv === undefined ? "none" : String(uv)} />
					<Showcase.Readout.Row
						label="sign count"
						testID="pk-sign-count"
						value={signCount === undefined ? "none" : String(signCount)}
					/>
					<Showcase.Readout.Row label="origin" testID="pk-origin" value={origin ?? "none"} />
				</Showcase.Readout>
				<Showcase.Section title="Calls">
					<PasskeyLog events={events} />
				</Showcase.Section>
			</Showcase.Body>
			<Showcase.Footer>
				<Showcase.Action
					icon={action.kind === "sign-out" ? undefined : (color) => <IconPasskeys color={color} size={20} />}
					label={action.label}
					onPress={action.kind === "wait" ? () => undefined : onPress}
					testID="pk-action"
					variant={action.variant}
				/>
			</Showcase.Footer>
		</Showcase>
	);
}
