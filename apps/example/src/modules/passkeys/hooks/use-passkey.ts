import { getRandomBytes } from "expo-crypto";
import { useCallback, useRef, useState } from "react";
import { Passkey } from "react-native-passkey";
import { failureOf, type PasskeyStatus } from "../utils/passkey-state";
import {
	type Assertion,
	b64urlEncode,
	type Registration,
	type VerifyFailure,
	verifyAssertion,
	verifyRegistration,
} from "../utils/webauthn";

/** The relying party the screen registers with. warden's virtual authenticator answers for any rp id. */
export const RP_ID = "warden.co.nz";
export const USER_NAME = "demo@warden.co.nz";

/** One line of the passkey log; `at` is milliseconds since the screen mounted. */
export type PasskeyEvent =
	| { kind: "create-requested"; at: number }
	| { kind: "saved"; at: number; tookMs: number; credentialId: string }
	| { kind: "sign-in-requested"; at: number }
	| { kind: "signed-in"; at: number; tookMs: number; userVerified: boolean }
	| { kind: "cancelled"; at: number; error: string }
	| { kind: "failed"; at: number; error: string }
	| { kind: "rejected"; at: number; reason: VerifyFailure }
	| { kind: "signed-out"; at: number };

/** The log keeps the latest few lines; the screen has room for no more. */
const MAX_EVENTS = 3;

const challenge = () => b64urlEncode(getRandomBytes(32));

/**
 * Passkey create and sign-in over `react-native-passkey` (iOS `ASAuthorizationController`, Android Credential
 * Manager), each response checked by the screen itself (`verifyRegistration` / `verifyAssertion`) before it says
 * Saved or Signed in: a response that fails a check is `Rejected` with the check's name. A fresh challenge per call;
 * one user id per screen mount. The credential lives only in this screen's state, like the app's other data.
 */
export function usePasskey(): {
	status: PasskeyStatus;
	error: string;
	registration: Registration | undefined;
	assertion: Assertion | undefined;
	events: readonly PasskeyEvent[];
	create: () => Promise<void>;
	signIn: () => Promise<void>;
	signOut: () => void;
} {
	const [status, setStatus] = useState<PasskeyStatus>(() => (Passkey.isSupported() ? "No passkey" : "Unsupported"));
	const [error, setError] = useState("none");
	const [registration, setRegistration] = useState<Registration | undefined>(undefined);
	const [assertion, setAssertion] = useState<Assertion | undefined>(undefined);
	const [events, setEvents] = useState<readonly PasskeyEvent[]>([]);
	const mountedAt = useRef(Date.now());
	const userId = useRef(b64urlEncode(getRandomBytes(16)));

	const log = useCallback((event: PasskeyEvent) => {
		setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
	}, []);
	const since = useCallback(() => Date.now() - mountedAt.current, []);

	const fail = useCallback(
		(thrown: unknown) => {
			const failure = failureOf(thrown);
			setError(failure.error);
			setStatus(failure.status);
			const at = since();
			log(
				failure.status === "Cancelled"
					? { kind: "cancelled", at, error: failure.error }
					: { kind: "failed", at, error: failure.error }
			);
		},
		[log, since]
	);

	const reject = useCallback(
		(reason: VerifyFailure) => {
			setError(reason);
			setStatus("Rejected");
			log({ kind: "rejected", at: since(), reason });
		},
		[log, since]
	);

	const create = useCallback(async () => {
		const expected = { challenge: challenge(), rpId: RP_ID };
		const startedAt = since();
		setStatus("Creating");
		setError("none");
		log({ kind: "create-requested", at: startedAt });
		try {
			const result = await Passkey.createPlatformKey({
				challenge: expected.challenge,
				rp: { id: RP_ID, name: "warden example" },
				user: { id: userId.current, name: USER_NAME, displayName: "Demo" },
				pubKeyCredParams: [{ type: "public-key", alg: -7 }],
				authenticatorSelection: { residentKey: "required", userVerification: "required" },
				attestation: "none",
			});
			const verdict = verifyRegistration(result, expected);
			if (!verdict.ok) return reject(verdict.reason);
			const at = since();
			setRegistration(verdict.value);
			setAssertion(undefined);
			setStatus("Saved");
			log({ kind: "saved", at, tookMs: at - startedAt, credentialId: verdict.value.credentialId });
		} catch (thrown) {
			fail(thrown);
		}
	}, [fail, log, reject, since]);

	const signIn = useCallback(async () => {
		if (!registration) return;
		const expected = { challenge: challenge(), rpId: RP_ID };
		const startedAt = since();
		setStatus("Signing in");
		setError("none");
		log({ kind: "sign-in-requested", at: startedAt });
		try {
			const result = await Passkey.getPlatformKey({
				challenge: expected.challenge,
				rpId: RP_ID,
				allowCredentials: [{ type: "public-key", id: registration.credentialId }],
				userVerification: "required",
			});
			const verdict = verifyAssertion(result, registration, expected);
			if (!verdict.ok) return reject(verdict.reason);
			const at = since();
			setAssertion(verdict.value);
			setStatus("Signed in");
			log({ kind: "signed-in", at, tookMs: at - startedAt, userVerified: verdict.value.userVerified });
		} catch (thrown) {
			fail(thrown);
		}
	}, [fail, log, registration, reject, since]);

	const signOut = useCallback(() => {
		setStatus("Saved");
		setError("none");
		setAssertion(undefined);
		log({ kind: "signed-out", at: since() });
	}, [log, since]);

	return { status, error, registration, assertion, events, create, signIn, signOut };
}
