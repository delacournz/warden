import { router, useIsFocused } from "expo-router";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { IS_E2E } from "@/modules/e2e/is-e2e";
import { useSession } from "@/modules/session/contexts/session.context";
import { type CredentialsCheck, validateCredentials } from "@/modules/session/utils/credentials";

/** How long the fake sign-in request takes, so the button's loading state is observable. */
const SIGN_IN_DELAY_MS = 400;

/**
 * e2e builds opt both fields out of iOS credential AutoFill: otherwise iOS offers to save the password in a
 * "Save Password?" sheet that appears seconds after sign-in (the system sheet is hosted by SafariViewService,
 * cold-launched, so how late it shows varies with load) and swallows the keystrokes of whatever the flow does
 * next: on the `--dev` run the dev client reloaded its JS in the middle of that typing.
 */
const NO_AUTOFILL = IS_E2E ? ({ autoComplete: "off", textContentType: "oneTimeCode" } as const) : {};

type FailedCheck = Extract<CredentialsCheck, { ok: false }>;

/**
 * Email + password form. Field errors come from `validateCredentials`;
 * `locked@example.com` yields a form-level alert instead. The footer is sticky so Sign in stays above the keyboard.
 */
export default function SignIn() {
	const { signIn } = useSession();
	const isFocused = useIsFocused();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<FailedCheck | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const submit = () => {
		const check = validateCredentials({ email, password });
		if (!check.ok) {
			setError(check);
			return;
		}
		setError(null);
		setIsSubmitting(true);
		setTimeout(() => {
			signIn(email);
			setIsSubmitting(false);
			router.replace("/todos");
		}, SIGN_IN_DELAY_MS);
	};

	return (
		<Screen testID="sign-in-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton onPress={() => router.back()} testID="sign-in-back">
					<Screen.Navbar.Title>Sign in</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.ScrollArea contentContainerClassName="gap-5 px-5" keyboardAware>
				<Text.Paragraph color="muted">Any email works. Passwords need 8+ characters.</Text.Paragraph>
				{error?.field === "form" ? (
					<Alert status="destructive" testID="sign-in-error">
						<Alert.Indicator />
						<Alert.Content>
							<Alert.Title>Can't sign in</Alert.Title>
							<Alert.Description>{error.message}</Alert.Description>
						</Alert.Content>
					</Alert>
				) : null}
				<Field isInvalid={error?.field === "email"}>
					<Field.Label>Email</Field.Label>
					<Input
						autoCapitalize="none"
						autoComplete="email"
						{...NO_AUTOFILL}
						inputMode="email"
						onChangeText={setEmail}
						placeholder="ada@example.com"
						testID="sign-in-email"
						value={email}
					/>
					<Field.Error testID="sign-in-email-error">{error?.field === "email" ? error.message : null}</Field.Error>
				</Field>
				<Field isInvalid={error?.field === "password"}>
					<Field.Label>Password</Field.Label>
					<Input
						{...NO_AUTOFILL}
						onChangeText={setPassword}
						onSubmitEditing={submit}
						placeholder="At least 8 characters"
						returnKeyType="go"
						secureTextEntry
						testID="sign-in-password"
						value={password}
					/>
					<Field.Error testID="sign-in-password-error">
						{error?.field === "password" ? error.message : null}
					</Field.Error>
				</Field>
			</Screen.ScrollArea>
			<Screen.Footer isFocused={isFocused} sticky>
				<Button isLoading={isSubmitting} onPress={submit} testID="sign-in-submit">
					Sign in
				</Button>
			</Screen.Footer>
		</Screen>
	);
}
