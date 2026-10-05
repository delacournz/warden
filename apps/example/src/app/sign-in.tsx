import { router, useIsFocused } from "expo-router";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useSession } from "@/modules/session/contexts/session.context";
import { type CredentialsCheck, validateCredentials } from "@/modules/session/utils/credentials";

/** How long the fake sign-in request takes, so the button's loading state is observable. */
const SIGN_IN_DELAY_MS = 400;

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
